import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parsePeriod } from "@/domain/periods";
import { activeAndMrr, aceContinuation, commissionsReport, discountsGiven, endedClients, expectedVsCollected, newClients, revenue, withPrevious } from "@/reports/queries";
import { resetDb } from "../helpers/db";

const TZ = "America/New_York";
const nov = parsePeriod("month", "2026-11", TZ);
const oct = parsePeriod("month", "2026-10", TZ);
const d = (s: string) => new Date(s);
let n = 0;
async function inv(clientId: string | null, o: Record<string, unknown>) {
  return db.invoice.create({
    data: { stripeInvoiceId: `in_${++n}`, clientId, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 0, totalCents: 0, periodStart: d("2026-11-05T12:00:00Z"), periodEnd: d("2026-12-05T12:00:00Z"), ...o },
  });
}

beforeEach(async () => { await resetDb(); n = 0; });

describe("revenue (cash, by payment date)", () => {
  it("splits packages, onboarding, card fees, ACE and refunds without double counting; time-zone edge", async () => {
    const g = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000 } });
    const c = await db.client.create({ data: { name: "A", packageId: g.id } });
    // Monthly charge by credit card: 650 + 19.50 fee
    await inv(c.id, { subtotalCents: 66950, totalCents: 66950, amountPaidCents: 66950, cardFeeCents: 1950, paidAt: d("2026-11-10T15:00:00Z") });
    // Onboarding fee invoice paid 11:30 pm New York on Nov 30 → November
    await inv(c.id, { kind: "ONBOARDING", subtotalCents: 50000, totalCents: 50000, amountPaidCents: 50000, onboardingCents: 50000, paidAt: d("2026-12-01T04:30:00Z") });
    // Refunded 100 on a November payment
    await inv(c.id, { subtotalCents: 65000, totalCents: 65000, amountPaidCents: 65000, refundedCents: 10000, refundedPackageCents: 10000, paidAt: d("2026-11-12T15:00:00Z") });
    // Paid in December: not counted
    await inv(c.id, { subtotalCents: 65000, totalCents: 65000, amountPaidCents: 65000, paidAt: d("2026-12-01T05:30:00Z") });
    // Unpaid: not counted
    await inv(c.id, { status: "open", subtotalCents: 65000, totalCents: 65000 });
    // ACE batch paid in November, counted once as ACE
    await db.aceBatch.create({ data: { purchasedAt: d("2026-11-01T12:00:00Z"), totalCents: 400000, createdById: "u", paidAt: d("2026-11-15T15:00:00Z") } });
    await db.aceBatch.create({ data: { purchasedAt: d("2026-11-01T12:00:00Z"), totalCents: 999, createdById: "u" } });

    const r = await revenue(nov);
    expect(r.types).toEqual({ packagesCents: 130000, onboardingCents: 50000, cardFeesCents: 1950, aceCents: 400000, otherCents: 0, taxCents: 0, refundsCents: -10000, totalCents: 571950 });
    expect(r.byPackage).toEqual([{ name: "Growth", cents: 120000 }]);
  });

  it("an empty period is all zeros, and the previous period comes along", async () => {
    const r = await withPrevious(revenue, nov);
    expect(r.current.types.totalCents).toBe(0);
    expect(r.previous.types.totalCents).toBe(0);
    expect(r.previousPeriod.key).toBe("2026-10");
  });
});

describe("expected vs collected", () => {
  it("bills starting in the period, what was paid, and what's past due", async () => {
    const c = await db.client.create({ data: { name: "A" } });
    await inv(c.id, { totalCents: 65000, amountPaidCents: 65000 });
    await inv(c.id, { status: "open", totalCents: 50000, firstFailedAt: d("2026-11-06T12:00:00Z") });
    await inv(c.id, { status: "void", totalCents: 99999 });
    await inv(c.id, { status: "open", totalCents: 30000, firstFailedAt: d("2026-10-06T12:00:00Z"), periodStart: d("2026-10-05T12:00:00Z") });
    expect(await expectedVsCollected(nov)).toEqual({ expectedCents: 115000, collectedCents: 65000, outstandingPastDueCents: 80000 });
  });
});

describe("past due without a recorded failure date (e.g. loaded from history)", () => {
  it("counts bills still unpaid more than 3 days after their bill date, but not newer ones or bank payments clearing", async () => {
    const c = await db.client.create({ data: { name: "A" } });
    await inv(c.id, { status: "open", totalCents: 40000, periodStart: d("2026-11-10T12:00:00Z") });
    await inv(c.id, { status: "open", totalCents: 7000, periodStart: d("2026-11-29T12:00:00Z") });
    await inv(c.id, { status: "open", totalCents: 9000, periodStart: d("2026-11-10T12:00:00Z"), processingSince: d("2026-11-11T12:00:00Z") });
    expect((await expectedVsCollected(nov, d("2026-11-30T12:00:00Z"))).outstandingPastDueCents).toBe(40000);
  });
});

describe("clients", () => {
  it("new clients by start date, package and type; ended clients", async () => {
    const g = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    const a = await db.client.create({ data: { name: "Onboarded", packageId: g.id } });
    await db.onboarding.create({ data: { clientId: a.id, feePaidAt: d("2026-11-03T12:00:00Z") } });
    const b = await db.client.create({ data: { name: "Ace", type: "ACE", packageId: g.id } });
    const batch = await db.aceBatch.create({ data: { purchasedAt: d("2026-10-01T12:00:00Z"), totalCents: 1, createdById: "u" } });
    await db.aceSlot.create({ data: { batchId: batch.id, packageId: g.id, clientId: b.id, startDate: d("2026-11-09T12:00:00Z") } });
    const old = await db.client.create({ data: { name: "Old", packageId: g.id, endedAt: d("2026-11-20T12:00:00Z") } });
    await inv(old.id, { amountPaidCents: 1, totalCents: 1, paidAt: d("2026-06-01T12:00:00Z") });
    const r = await newClients(nov);
    expect(r).toMatchObject({ total: 2, direct: 1, ace: 1, byPackage: [{ name: "Growth", count: 2 }] });
    expect((await newClients(oct)).total).toBe(0);
    expect((await endedClients(nov)).clients.map((c) => c.name)).toEqual(["Old"]);
  });

  it("ACE continuation rate", async () => {
    const mk = (name: string, o: Record<string, unknown>) => db.client.create({ data: { name, type: "ACE", acePrepaidUntil: d("2026-11-15T12:00:00Z"), ...o } });
    await mk("Stayed", { stripeSubscriptionId: "sub_1" });
    await mk("Will stay", { continuationDecision: "CONTINUING" });
    await mk("Left", { endedAt: d("2026-11-15T12:00:00Z") });
    await mk("Unsure", {});
    await mk("Later", { acePrepaidUntil: d("2027-01-15T12:00:00Z") });
    expect(await aceContinuation(nov)).toMatchObject({ continued: 2, ended: 1, undecided: 1, ratePct: 66.7 });
    expect((await aceContinuation(oct)).ratePct).toBeNull();
  });

  it("active clients and MRR per month, with ACE-prepaid clients counted as active", async () => {
    const a = await db.client.create({ data: { name: "A" } });
    await inv(a.id, { subtotalCents: 66950, cardFeeCents: 1950, discountCents: 5000, totalCents: 61950 });
    await inv(a.id, { status: "void", subtotalCents: 1000 });
    const b = await db.client.create({ data: { name: "Ace", type: "ACE" } });
    const batch = await db.aceBatch.create({ data: { purchasedAt: d("2026-10-01T12:00:00Z"), totalCents: 1, createdById: "u" } });
    await db.aceSlot.create({ data: { batchId: batch.id, packageId: "p", clientId: b.id, startDate: d("2026-10-10T12:00:00Z"), prepaidUntil: d("2027-04-09T12:00:00Z") } });
    expect(await activeAndMrr(nov, 2)).toEqual([
      { key: "2026-10", label: "October 2026", active: 1, mrrCents: 0 },
      { key: "2026-11", label: "November 2026", active: 2, mrrCents: 60000 },
    ]);
  });
});

describe("discounts and commissions", () => {
  it("discount value on paid invoices", async () => {
    const a = await db.client.create({ data: { name: "A" } });
    await inv(a.id, { discountCents: 6500, amountPaidCents: 58500, totalCents: 58500, paidAt: d("2026-11-10T12:00:00Z") });
    await inv(a.id, { status: "open", discountCents: 6500 });
    expect(await discountsGiven(nov)).toEqual({ totalCents: 6500, byClient: [{ name: "A", cents: 6500 }] });
  });

  it("commissions per executive with paid vs unpaid", async () => {
    const jose = await db.executive.create({ data: { name: "Jose" } });
    const al = await db.executive.create({ data: { name: "Albert" } });
    const e = (executiveId: string, kind: "EARNED" | "CLAWBACK" | "ACE_PREPAID", amountCents: number, month: string) =>
      db.commissionEntry.create({ data: { executiveId, clientId: "c", invoiceId: `i${++n}`, kind, baseCents: 1, rateBp: 1000, amountCents, occurredAt: d("2026-11-10T12:00:00Z"), month } });
    await e(jose.id, "EARNED", 6500, "2026-11");
    await e(jose.id, "ACE_PREPAID", 39000, "2026-11");
    await e(jose.id, "CLAWBACK", -1000, "2026-12");
    await e(al.id, "EARNED", 3250, "2026-11");
    await db.commissionStatement.create({ data: { executiveId: jose.id, month: "2026-11", status: "PAID" } });
    expect(await commissionsReport(nov)).toEqual({
      byExecutive: [
        { name: "Albert", earnedCents: 3250, clawbackCents: 0, netCents: 3250, paidCents: 0, unpaidCents: 3250 },
        { name: "Jose", earnedCents: 45500, clawbackCents: -1000, netCents: 44500, paidCents: 45500, unpaidCents: -1000 },
      ],
      totals: { earnedCents: 48750, clawbackCents: -1000, netCents: 47750, paidCents: 45500, unpaidCents: 2250 },
    });
  });
});
