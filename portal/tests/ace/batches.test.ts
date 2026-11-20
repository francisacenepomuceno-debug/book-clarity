import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createBatch, recordBatchPayment, setAceCustomer, batchDetail } from "@/ace/batches";
import { handleStripeEvent } from "@/stripe/webhook";
import { defaultWebhookDeps } from "@/stripe/deps";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "../stripe/fixtures";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "a", email: "a@x.co", name: "A", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

function fakeStripe() {
  return {
    customers: { retrieve: vi.fn(async (id: string) => ({ id, name: "ACE", deleted: false })) },
    invoices: {
      create: vi.fn(async () => ({ id: "in_ace" })),
      finalizeInvoice: vi.fn(async () => ({ id: "in_ace" })),
      sendInvoice: vi.fn(async () => ({ id: "in_ace" })),
      pay: vi.fn(async () => ({ id: "in_ace", status: "paid" })),
    },
    invoiceItems: { create: vi.fn(async () => ({ id: "ii" })) },
    invoicePayments: { list: vi.fn(async () => ({ data: [{ payment: { payment_intent: { latest_charge: { id: "ch", payment_method_details: { type: "us_bank_account" } } } } }] })) },
  };
}
const stripeRef: { current: ReturnType<typeof fakeStripe> } = { current: fakeStripe() };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const s = () => stripeRef.current;

let essentials: string;
let custom: string;
beforeEach(async () => {
  await resetDb();
  stripeRef.current = fakeStripe();
  sessionRef.current = OWNER;
  essentials = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 30000 } })).id;
  custom = (await db.package.create({ data: { name: "Custom", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: true } })).id;
});

const lines = () => [
  { packageId: essentials, quantity: 10, unitPriceCents: 260000 },
  { packageId: custom, quantity: 1, unitPriceCents: 500000 },
];

describe("createBatch", () => {
  it("needs ACE's Stripe customer first", async () => {
    expect(await createBatch({ purchasedOn: "2026-11-01", lines: lines() })).toEqual({ ok: false, error: "Set ACE's Stripe customer in Settings first." });
  });

  it("creates slots and a Stripe invoice to ACE (ACH / bank transfer)", async () => {
    expect((await setAceCustomer("cus_ace")).ok).toBe(true);
    const r = await createBatch({ purchasedOn: "2026-11-01", lines: lines() });
    expect(r.ok).toBe(true);
    const batchId = (r as { batchId: string }).batchId;
    expect(await db.aceSlot.count({ where: { batchId } })).toBe(11);
    const batch = await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({ totalCents: 3100000, stripeInvoiceId: "in_ace", paidAt: null });
    const [params, opts] = s().invoices.create.mock.calls[0] as unknown as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({ customer: "cus_ace", collection_method: "send_invoice", days_until_due: 14, metadata: { kind: "ACE_BATCH", batchId } });
    expect((params.payment_settings as { payment_method_types: string[] }).payment_method_types).toEqual(["us_bank_account", "customer_balance"]);
    expect(opts.idempotencyKey).toBe(`bc-ace-batch-${batchId}`);
    expect(s().invoiceItems.create).toHaveBeenCalledTimes(2);
    expect((s().invoiceItems.create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ amount: 2600000, description: "10 × Essentials — 6 months + onboarding (ACE)" });
    expect(s().invoices.sendInvoice).toHaveBeenCalledWith("in_ace");
  });

  it("a historical batch already paid outside the portal makes no Stripe calls", async () => {
    const r = await createBatch({ purchasedOn: "2026-03-01", lines: lines(), alreadyPaid: { paidOn: "2026-03-05", method: "check", reference: "Check 1042" } });
    expect(r.ok).toBe(true);
    expect(s().invoices.create).not.toHaveBeenCalled();
    const b = await db.aceBatch.findFirstOrThrow();
    expect(b).toMatchObject({ paidVia: "OUT_OF_BAND", paymentMethod: "check", paymentReference: "Check 1042" });
    expect(b.paidAt).not.toBeNull();
  });

  it("refuses a zero quantity and Admins", async () => {
    await setAceCustomer("cus_ace");
    expect((await createBatch({ purchasedOn: "2026-11-01", lines: [{ packageId: essentials, quantity: 0, unitPriceCents: 1 }] })).ok).toBe(false);
    sessionRef.current = ADMIN;
    expect(await createBatch({ purchasedOn: "2026-11-01", lines: lines() })).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await db.aceBatch.count()).toBe(0);
  });
});

describe("payments", () => {
  async function stripeBatch() {
    await setAceCustomer("cus_ace");
    return ((await createBatch({ purchasedOn: "2026-11-01", lines: lines() })) as { batchId: string }).batchId;
  }

  it("record payment received marks the Stripe invoice paid out of band, once", async () => {
    const batchId = await stripeBatch();
    expect((await recordBatchPayment(batchId, { paidOn: "2026-11-10", method: "bank_transfer", reference: "WIRE 77" })).ok).toBe(true);
    expect(s().invoices.pay).toHaveBeenCalledWith("in_ace", { paid_out_of_band: true }, { idempotencyKey: `bc-ace-oob-${batchId}` });
    expect((await recordBatchPayment(batchId, { paidOn: "2026-11-10", method: "bank_transfer", reference: "WIRE 77" })).ok).toBe(false);
    expect((await batchDetail(batchId))!.paidVia).toBe("OUT_OF_BAND");
  });

  it("invoice.paid from Stripe marks the batch paid; a repeat changes nothing", async () => {
    const batchId = await stripeBatch();
    const inv = invoice({ id: "in_ace", customer: "cus_ace", status: "paid", parent: null, metadata: { kind: "ACE_BATCH", batchId }, status_transitions: { paid_at: ts("2026-11-12") } });
    await handleStripeEvent(event("invoice.paid", inv, "evt_a"), defaultWebhookDeps());
    const first = await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(first.paidAt?.toISOString().slice(0, 10)).toBe("2026-11-12");
    expect(first).toMatchObject({ paidVia: "STRIPE", paymentMethod: "us_bank_account" });
    await handleStripeEvent(event("invoice.paid", { ...inv, status_transitions: { paid_at: ts("2026-12-01") } }, "evt_b"), defaultWebhookDeps());
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } })).paidAt?.toISOString().slice(0, 10)).toBe("2026-11-12");
  });
});
