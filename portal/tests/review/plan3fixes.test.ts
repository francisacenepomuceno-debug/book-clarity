import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { assignSlot, postAceCommission } from "@/ace/slots";
import { createBatch, issueBatchInvoice, onBatchInvoicePaid, recordBatchPayment, setAceCustomer } from "@/ace/batches";
import { markContinuing, markEnded, onSetupCompleted, startSetupFromToken } from "@/ace/continuation";
import { setClientCommission } from "@/commissions/splits";
import { aceDashboardRows, withClientTypes } from "@/clients/queries";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };

function fakeStripe() {
  return {
    customers: { retrieve: vi.fn(async (id: string) => ({ id })), create: vi.fn(async () => ({ id: "cus_new" })), update: vi.fn(async () => ({})) },
    invoices: {
      create: vi.fn(async () => ({ id: "in_ace" })),
      finalizeInvoice: vi.fn(async () => ({ id: "in_ace" })),
      sendInvoice: vi.fn(async () => ({ id: "in_ace" })),
      pay: vi.fn(async () => ({ id: "in_ace" })),
      retrieve: vi.fn(async () => ({ id: "in_ace", status: "draft" })),
    },
    invoiceItems: { create: vi.fn(async () => ({ id: "ii" })) },
    invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" })), expire: vi.fn(async () => ({})) } },
    setupIntents: { retrieve: vi.fn(async () => ({ id: "seti_1", payment_method: "pm_1" })) },
    prices: { create: vi.fn(async () => ({ id: "price_x" })) },
    subscriptions: { create: vi.fn(async () => ({ id: "sub_new" })) },
  };
}
const stripeRef: { current: ReturnType<typeof fakeStripe> } = { current: fakeStripe() };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const s = () => stripeRef.current;

const DAY = 86400_000;
const NY = "America/New_York";
const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
let growth: string;
let jose: string;
let albert: string;

async function paidBatch(qty = 1) {
  const r = await createBatch({ purchasedOn: "2026-10-01", lines: [{ packageId: growth, quantity: qty, unitPriceCents: 450000 }], alreadyPaid: { paidOn: "2026-10-02", method: "check", reference: "1" } });
  return (r as { batchId: string }).batchId;
}
async function aceClient(name: string, daysLeft: number) {
  const until = new Date(Date.now() + daysLeft * DAY);
  const c = await db.client.create({ data: { name, type: "ACE", status: "PREPAID_ACE", acePrepaidUntil: until, packageId: growth } });
  const b = await db.aceBatch.create({ data: { purchasedAt: new Date(), totalCents: 1, createdById: "u", paidAt: new Date() } });
  const slot = await db.aceSlot.create({ data: { batchId: b.id, packageId: growth, clientId: c.id, startDate: new Date(), prepaidUntil: until } });
  await db.client.update({ where: { id: c.id }, data: { aceSlotId: slot.id } });
  return c.id;
}
const setupSession = (clientId: string) =>
  ({ id: "cs_1", customer: "cus_new", setup_intent: "seti_1", metadata: { kind: "ACE_CONTINUATION", clientId } }) as unknown as Stripe.Checkout.Session;

beforeEach(async () => {
  await resetDb();
  stripeRef.current = fakeStripe();
  sessionRef.current = OWNER;
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0, stripePriceId: "price_growth" } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  albert = (await db.executive.create({ data: { name: "Albert" } })).id;
});

describe("I1: the ACE lump posts once per slot, even if the split is corrected", () => {
  it("a same-date correction doesn't pay a second executive", async () => {
    const c = (await db.client.create({ data: { name: "A", status: "ONBOARDING" } })).id;
    await setClientCommission(c, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    const b = await paidBatch();
    await assignSlot({ batchId: b, packageId: growth, clientId: c, startOn: day(new Date()) });
    await setClientCommission(c, { shares: [{ executiveId: albert, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    expect((await db.commissionEntry.findMany()).map((e) => e.executiveId)).toEqual([jose]);
  });
});

describe("I2: an owner set after the start date still earns the ACE lump", () => {
  it("falls back to the earliest split when none covers the start date", async () => {
    const c = (await db.client.create({ data: { name: "B", status: "ONBOARDING" } })).id;
    const b = await paidBatch();
    const start = new Date(Date.now() - 10 * DAY);
    await assignSlot({ batchId: b, packageId: growth, clientId: c, startOn: day(start) });
    await setClientCommission(c, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date() });
    expect((await db.commissionEntry.findMany()).map((e) => [e.kind, e.amountCents])).toEqual([["ACE_PREPAID", 39000]]);
  });
});

describe("I3: 'Not continuing' wins over a late setup link", () => {
  it("no subscription is created and the open Checkout session is expired", async () => {
    const id = await aceClient("C", 20);
    const r = await markContinuing(id, "https://portal.test");
    expect(r.ok).toBe(true);
    await startSetupFromToken((r as { setupUrl: string }).setupUrl.split("/continue/")[1], "https://portal.test");
    await markEnded(id);
    expect(s().checkout.sessions.expire).toHaveBeenCalledWith("cs_1");
    await onSetupCompleted(setupSession(id), s() as unknown as Stripe);
    expect(s().subscriptions.create).not.toHaveBeenCalled();
  });
});

describe("I4: setup finished after the prepaid period starts billing now instead of failing", () => {
  it("creates the subscription without a trial", async () => {
    const id = await aceClient("D", 10);
    await markContinuing(id, "https://portal.test");
    await db.client.update({ where: { id }, data: { acePrepaidUntil: new Date(Date.now() - 2 * DAY) } });
    await onSetupCompleted(setupSession(id), s() as unknown as Stripe);
    const params = (s().subscriptions.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params.trial_end).toBeUndefined();
    expect((await db.client.findUniqueOrThrow({ where: { id } })).stripeSubscriptionId).toBe("sub_new");
  });
});

describe("I5: Stripe's webhook doesn't overwrite a payment recorded by hand", () => {
  it("an out-of-band invoice.paid is ignored", async () => {
    await setAceCustomer("cus_ace");
    const b = ((await createBatch({ purchasedOn: "2026-11-01", lines: [{ packageId: growth, quantity: 1, unitPriceCents: 450000 }] })) as { batchId: string }).batchId;
    await onBatchInvoicePaid({ id: "in_ace", paid_out_of_band: true, metadata: { kind: "ACE_BATCH", batchId: b }, status_transitions: { paid_at: 1 } } as unknown as Stripe.Invoice);
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: b } })).paidAt).toBeNull();
    expect((await recordBatchPayment(b, { paidOn: "2026-11-10", method: "check", reference: "Check 9" })).ok).toBe(true);
    expect(await db.aceBatch.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ paidVia: "OUT_OF_BAND", paymentReference: "Check 9" });
  });
});

describe("I6: a Stripe failure mid-invoice keeps the invoice linked and can be retried", () => {
  it("saves the invoice id immediately and a retry finishes sending it", async () => {
    await setAceCustomer("cus_ace");
    s().invoices.sendInvoice.mockRejectedValueOnce(new Error("stripe down"));
    const r = await createBatch({ purchasedOn: "2026-11-01", lines: [{ packageId: growth, quantity: 1, unitPriceCents: 450000 }] });
    expect(r.ok).toBe(false);
    const b = await db.aceBatch.findFirstOrThrow();
    expect(b).toMatchObject({ stripeInvoiceId: "in_ace", invoiceSentAt: null });
    expect((await issueBatchInvoice(b.id)).ok).toBe(true);
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: b.id } })).invoiceSentAt).not.toBeNull();
    const keys = s().invoices.create.mock.calls.map((c) => ((c as unknown[])[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("I7: a client on autopay isn't silently put in a prepaid slot", () => {
  it("needs explicit confirmation", async () => {
    const c = (await db.client.create({ data: { name: "E", status: "CURRENT", stripeSubscriptionId: "sub_live" } })).id;
    const b = await paidBatch(2);
    const r = await assignSlot({ batchId: b, packageId: growth, clientId: c, startOn: day(new Date()) });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/autopay/);
    expect((await assignSlot({ batchId: b, packageId: growth, clientId: c, startOn: day(new Date()), confirmSubscribed: true })).ok).toBe(true);
  });
});

describe("I8: ACE statuses stay current", () => {
  it("dashboard rows refresh a client whose prepaid period ended", async () => {
    const id = await aceClient("F", 10);
    await markContinuing(id, "https://portal.test");
    await db.client.update({ where: { id }, data: { acePrepaidUntil: new Date(Date.now() - DAY), status: "PREPAID_ACE" } });
    expect((await aceDashboardRows()).find((r) => r.subscriptionId === id)?.status).toBe("CONTINUING_AWAITING_PM");
  });
  it("a continued ACE client still inside the prepaid period shows Prepaid by ACE on live rows", async () => {
    const id = await aceClient("G", 10);
    await db.client.update({ where: { id }, data: { stripeSubscriptionId: "sub_g" } });
    const [r] = await withClientTypes([{ subscriptionId: "sub_g", status: "PAST_DUE" } as never]);
    expect(r).toMatchObject({ clientType: "ACE", status: "PREPAID_ACE" });
  });
});

describe("I9: the link sent to the client doesn't expire", () => {
  it("is a portal link that opens a fresh Stripe session each time, and refuses once ended", async () => {
    const id = await aceClient("H", 20);
    const r = (await markContinuing(id, "https://portal.test")) as { setupUrl: string };
    expect(r.setupUrl).toMatch(/^https:\/\/portal\.test\/continue\//);
    expect(s().checkout.sessions.create).not.toHaveBeenCalled();
    const token = r.setupUrl.split("/continue/")[1];
    expect(await startSetupFromToken(token, "https://portal.test")).toEqual({ url: "https://checkout.stripe.test/cs_1" });
    expect(await startSetupFromToken(token, "https://portal.test")).toEqual({ url: "https://checkout.stripe.test/cs_1" });
    expect(s().checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(await startSetupFromToken(token.slice(0, -2) + "xx", "https://portal.test")).toEqual({ error: expect.any(String) });
    await markEnded(id);
    expect(await startSetupFromToken(token, "https://portal.test")).toEqual({ error: expect.stringMatching(/no longer/) });
  });
});
