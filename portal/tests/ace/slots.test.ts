import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { assignSlot, postAceCommissionsForBatch } from "@/ace/slots";
import { createBatch, recordBatchPayment } from "@/ace/batches";
import { setClientCommission } from "@/commissions/splits";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { prepaidUntil } from "@/domain/ace";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
vi.mock("@/stripe/client", () => ({ getStripe: () => ({ invoices: { pay: vi.fn(async () => ({})) } }) }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };

const NY = "America/New_York";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

let growth: string;
let custom: string;
let jose: string;
let c1: string;
let c2: string;

async function batch(paid: boolean, qty = 1, packageId = growth) {
  const r = await createBatch({
    purchasedOn: "2026-10-01",
    lines: [{ packageId, quantity: qty, unitPriceCents: 450000 }],
    ...(paid ? { alreadyPaid: { paidOn: "2026-10-05", method: "check" as const, reference: "1" } } : {}),
  });
  if (!paid) {
    // unpaid historical-style batch: create paid, then clear payment (no ACE Stripe customer in tests)
  }
  return (r as { batchId: string }).batchId;
}
async function unpaidBatch(qty = 1, packageId = growth) {
  const id = await batch(true, qty, packageId);
  await db.aceBatch.update({ where: { id }, data: { paidAt: null, paidVia: null, paymentMethod: null, paymentReference: null } });
  return id;
}

beforeEach(async () => {
  await resetDb();
  sessionRef.current = OWNER;
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000 } })).id;
  custom = (await db.package.create({ data: { name: "Custom", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: true } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  c1 = (await db.client.create({ data: { name: "First Co", status: "ONBOARDING" } })).id;
  c2 = (await db.client.create({ data: { name: "Second Co", status: "ONBOARDING" } })).id;
  for (const c of [c1, c2]) {
    await db.commissionShare.create({ data: { clientId: c, executiveId: jose, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u" } });
  }
});

describe("assignSlot", () => {
  it("paid batch: client is prepaid by ACE and the months 1–6 commission posts", async () => {
    const b = await batch(true);
    expect((await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today })).ok).toBe(true);
    const c = await db.client.findUniqueOrThrow({ where: { id: c1 } });
    expect(c).toMatchObject({ type: "ACE", status: "PREPAID_ACE", packageId: growth });
    expect(c.acePrepaidUntil?.toISOString()).toBe(prepaidUntil(today, NY).toISOString());
    const entries = await db.commissionEntry.findMany();
    expect(entries.map((e) => [e.kind, e.executiveId, e.baseCents, e.amountCents])).toEqual([["ACE_PREPAID", jose, 390000, 39000]]);
  });

  it("unpaid batch: commission is pending until the batch is paid, then posts once", async () => {
    const b = await unpaidBatch();
    await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today });
    expect(await db.commissionEntry.count()).toBe(0);
    expect((await recordBatchPayment(b, { paidOn: "2026-11-10", method: "check", reference: "2" })).ok).toBe(true);
    expect(await db.commissionEntry.count()).toBe(1);
    expect(await postAceCommissionsForBatch(b)).toBe(0);
    expect(await db.commissionEntry.count()).toBe(1);
  });

  it("refuses when no slot of that package is open, and the last slot goes to exactly one client", async () => {
    const b = await batch(true, 1);
    const [r1, r2] = await Promise.all([
      assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today }),
      assignSlot({ batchId: b, packageId: growth, clientId: c2, startOn: today }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const third = (await db.client.create({ data: { name: "Third", status: "ONBOARDING" } })).id;
    expect((await assignSlot({ batchId: b, packageId: growth, clientId: third, startOn: today })).ok).toBe(false);
  });

  it("a client can hold only one slot", async () => {
    const b = await batch(true, 2);
    await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today });
    expect((await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today })).ok).toBe(false);
  });

  it("Custom slots need a monthly price, which is the commission base", async () => {
    const b = await batch(true, 1, custom);
    expect((await assignSlot({ batchId: b, packageId: custom, clientId: c1, startOn: today })).ok).toBe(false);
    expect((await assignSlot({ batchId: b, packageId: custom, clientId: c1, startOn: today, customMonthlyCents: 200000 })).ok).toBe(true);
    expect((await db.commissionEntry.findFirstOrThrow()).baseCents).toBe(1200000);
  });

  it("an owner assigned later picks up the ACE commission", async () => {
    await db.commissionShare.deleteMany({ where: { clientId: c1 } });
    const b = await batch(true);
    await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today });
    expect(await db.commissionEntry.count()).toBe(0);
    await setClientCommission(c1, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    expect((await db.commissionEntry.findMany()).map((e) => e.kind)).toEqual(["ACE_PREPAID"]);
  });
});

describe("prepaid status", () => {
  it("a stray open, failed invoice during the prepaid period never makes the client past due", async () => {
    const b = await batch(true);
    await assignSlot({ batchId: b, packageId: growth, clientId: c1, startOn: today });
    await db.invoice.create({
      data: {
        stripeInvoiceId: "in_stray", clientId: c1, status: "open", kind: "SUBSCRIPTION", subtotalCents: 65000, totalCents: 65000,
        firstFailedAt: new Date(Date.now() - 25 * 86400_000), periodStart: new Date(), periodEnd: new Date(),
      },
    });
    expect(await refreshClientStatus(c1)).toBe("PREPAID_ACE");
  });
});
