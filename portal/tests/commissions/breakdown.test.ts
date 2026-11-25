import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addMonths, monthlyBreakdown } from "@/commissions/breakdown";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const now = new Date("2026-11-20T15:00:00Z");
let albert = "", jose = "", ess = "", ent = "";
let n = 0;

async function client(name: string, pkg: string, sub: string, monthsBefore = 0) {
  const c = await db.client.create({ data: { name, stripeCustomerId: `cus_${name}`, stripeSubscriptionId: sub, packageId: pkg, status: "CURRENT", commissionMonthsBeforePortal: monthsBefore } });
  await db.clientSubscription.create({ data: { clientId: c.id, stripeSubscriptionId: sub, packageId: pkg } });
  return c;
}
async function paidInvoice(clientId: string, sub: string, cents: number, paidAt: Date, method = { paymentMethodType: "us_bank_account", cardFunding: null as string | null }) {
  n += 1;
  return db.invoice.create({ data: { stripeInvoiceId: `in_${n}`, clientId, stripeSubscriptionId: sub, status: "paid", kind: "SUBSCRIPTION", subtotalCents: cents, totalCents: cents, amountPaidCents: cents, paidAt, periodStart: paidAt, periodEnd: paidAt, ...method } });
}

beforeEach(async () => {
  await resetDb();
  n = 0;
  await db.user.create({ data: { id: "u1", email: "u@x.co", name: "U", role: "OWNER" } });
  albert = (await db.executive.create({ data: { name: "Exec A" } })).id;
  jose = (await db.executive.create({ data: { name: "Exec B" } })).id;
  ess = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } })).id;
  ent = (await db.package.create({ data: { name: "Enterprise", monthlyPriceCents: 95000, onboardingFeeCents: 0 } })).id;
  as("OWNER");
});

describe("monthly commission breakdown", () => {
  it("lists each executive's paid clients by package, with payout number, final month, method, split and totals", async () => {
    const hub = await client("Acme LLC", ess, "sub_h", 3);
    await db.commissionShare.create({ data: { clientId: hub.id, executiveId: albert, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });
    const inv = await paidInvoice(hub.id, "sub_h", 35000, new Date("2026-11-05T15:00:00Z"));
    await db.commissionEntry.create({ data: { executiveId: albert, clientId: hub.id, invoiceId: inv.id, kind: "EARNED", windowIndex: 4, baseCents: 35000, rateBp: 1000, amountCents: 3500, occurredAt: inv.paidAt!, month: "2026-11" } });

    const autism = await client("Beta Co", ent, "sub_a", 11);
    for (const e of [albert, jose]) await db.commissionShare.create({ data: { clientId: autism.id, executiveId: e, rateBp: 500, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });
    const inv2 = await paidInvoice(autism.id, "sub_a", 97850, new Date("2026-11-14T15:00:00Z"), { paymentMethodType: "card", cardFunding: "credit" });
    await db.invoice.update({ where: { id: inv2.id }, data: { cardFeeCents: 2850 } });
    for (const e of [albert, jose]) await db.commissionEntry.create({ data: { executiveId: e, clientId: autism.id, invoiceId: inv2.id, kind: "EARNED", windowIndex: 12, baseCents: 95000, rateBp: 500, amountCents: 4750, occurredAt: inv2.paidAt!, month: "2026-11" } });

    const b = await monthlyBreakdown("2026-11", now);
    const al = b.find((x) => x.executiveName === "Exec A")!;
    expect(al.groups.map((g) => g.packageName)).toEqual(["Essentials", "Enterprise"]);
    expect(al.groups[0].rows[0]).toMatchObject({ clientName: "Acme LLC", payout: "4 of 12", finalMonth: "2027-07", paidCents: 35000, method: "ACH", commissionCents: 3500, expected: false });
    expect(al.groups[1].rows[0]).toMatchObject({ clientName: "Beta Co", payout: "12 of 12", finalMonth: "2026-11", method: "CC", commissionCents: 4750 });
    expect(al.groups[1].rows[0].notes).toEqual(expect.arrayContaining(["Final payout", "Split with Exec B (5%)"]));
    expect(al.totalCents).toBe(8250);
    expect(b.find((x) => x.executiveName === "Exec B")!.totalCents).toBe(4750);
  });

  it("this month: clients still to pay show as awaiting, estimated from their last payment; finished windows don't", async () => {
    const koi = await client("Gamma Studio", ent, "sub_k", 1);
    await db.commissionShare.create({ data: { clientId: koi.id, executiveId: albert, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });
    await paidInvoice(koi.id, "sub_k", 95000, new Date("2026-10-30T15:00:00Z"));
    const done = await client("Delta Marketing", ess, "sub_g", 12);
    await db.commissionShare.create({ data: { clientId: done.id, executiveId: albert, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });

    const al = (await monthlyBreakdown("2026-11", now)).find((x) => x.executiveName === "Exec A")!;
    const rows = al.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientName: "Gamma Studio", payout: "3 of 12", expected: true, commissionCents: 9500, notes: ["Awaiting payment"] });
    expect(al).toMatchObject({ totalCents: 0, expectedCents: 9500, status: "OPEN" });
    // Past months only show what was earned.
    expect(await monthlyBreakdown("2026-10", now)).toEqual([]);
  });

  it("a paid statement shows its frozen total; Admins can't see commission", async () => {
    const hub = await client("Acme LLC", ess, "sub_h");
    const inv = await paidInvoice(hub.id, "sub_h", 35000, new Date("2026-10-05T15:00:00Z"));
    await db.commissionEntry.create({ data: { executiveId: albert, clientId: hub.id, invoiceId: inv.id, kind: "EARNED", windowIndex: 1, baseCents: 35000, rateBp: 1000, amountCents: 3500, occurredAt: inv.paidAt!, month: "2026-10" } });
    await db.commissionStatement.create({ data: { executiveId: albert, month: "2026-10", status: "PAID", paidAt: new Date("2026-11-02"), totalCents: 3500 } });
    expect((await monthlyBreakdown("2026-10", now))[0]).toMatchObject({ status: "PAID", totalCents: 3500 });
    expect(addMonths("2026-11", 4)).toBe("2027-03");
    as("ADMIN");
    await expect(monthlyBreakdown("2026-10", now)).rejects.toThrow();
  });
});

describe("final payout month", () => {
  it("two bills paid in one month show the same final month, from the later payout", async () => {
    sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
    const c = await client("Two Bills", ess, "sub_t");
    for (const [i, day] of [[3, "04"], [4, "24"]] as const) {
      const inv = await paidInvoice(c.id, "sub_t", 20000, new Date(`2026-11-${day}T15:00:00Z`));
      await db.commissionEntry.create({ data: { executiveId: albert, clientId: c.id, invoiceId: inv.id, kind: "EARNED", windowIndex: i, baseCents: 20000, rateBp: 1000, amountCents: 2000, occurredAt: inv.paidAt!, month: "2026-11" } });
    }
    const rows = (await monthlyBreakdown("2026-11", now)).find((x) => x.executiveName === "Exec A")!.groups.flatMap((g) => g.rows);
    expect(rows.map((r) => [r.payout, r.finalMonth])).toEqual([["3 of 12", "2027-07"], ["4 of 12", "2027-07"]]);
  });
});
