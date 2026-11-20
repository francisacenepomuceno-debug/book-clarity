import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { handleStripeEvent, type WebhookDeps } from "@/stripe/webhook";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "./fixtures";

const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
  getPaidMethod: vi.fn(async () => ({ type: "card" as const, funding: "debit" as const, chargeId: "ch_1" })),
  getPaymentMethodFunding: vi.fn(async () => "credit"),
  onInvoiceCreated: vi.fn(async () => {}),
  onInvoicePaid: vi.fn(async () => {}),
  ...over,
});

let clientId: string;
beforeEach(async () => {
  await resetDb();
  const c = await db.client.create({
    data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" },
  });
  clientId = c.id;
});

const client = () => db.client.findUniqueOrThrow({ where: { id: clientId } });

describe("invoice sync", () => {
  it("payment_failed records the first failure once and marks Past due", async () => {
    await handleStripeEvent(event("invoice.payment_failed", invoice({ created: ts("2026-11-15") })), deps());
    const first = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(first.firstFailedAt).not.toBeNull();
    expect(first.kind).toBe("SUBSCRIPTION");
    expect((await client()).status).toBe("PAST_DUE");

    await new Promise((r) => setTimeout(r, 5));
    await handleStripeEvent(event("invoice.payment_failed", invoice()), deps());
    const again = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(again.firstFailedAt?.getTime()).toBe(first.firstFailedAt?.getTime());
  });

  it("paid records amount, method and funding, and marks Current", async () => {
    await handleStripeEvent(event("invoice.payment_failed", invoice()), deps());
    const paid = invoice({ status: "paid", amount_paid: 80000, amount_remaining: 0, status_transitions: { paid_at: ts("2026-12-03"), finalized_at: ts("2026-12-01") } });
    await handleStripeEvent(event("invoice.paid", paid), deps());
    const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(row.amountPaidCents).toBe(80000);
    expect(row.paidAt?.toISOString().slice(0, 10)).toBe("2026-12-03");
    expect(row.paymentMethodType).toBe("card");
    expect(row.cardFunding).toBe("debit");
    expect((await client()).status).toBe("CURRENT");
  });

  it("paid for an invoice never seen before (out of order) is upserted", async () => {
    const paid = invoice({ id: "in_new", status: "paid", amount_paid: 500, status_transitions: { paid_at: ts("2026-12-03") } });
    expect(await handleStripeEvent(event("invoice.paid", paid), deps())).toBe("processed");
    expect(await db.invoice.findUnique({ where: { stripeInvoiceId: "in_new" } })).not.toBeNull();
  });

  it("records card-fee and discount amounts from invoice lines", async () => {
    const inv = invoice({
      total_discount_amounts: [{ amount: 16000, discount: "di_1" }],
      lines: {
        data: [
          { id: "il_1", amount: 80000, description: "1 × Growth Package", metadata: {} },
          { id: "il_2", amount: 1950, description: "1 × 3% Credit Card Fee (at $19.50 / month)", metadata: {} },
        ],
      },
    });
    await handleStripeEvent(event("invoice.created", inv), deps());
    const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(row.cardFeeCents).toBe(1950);
    expect(row.discountCents).toBe(16000);
  });

  it("subscription deleted ends the client", async () => {
    await handleStripeEvent(event("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled", ended_at: ts("2026-11-10") }), deps());
    const c = await client();
    expect(c.status).toBe("ENDED");
    expect(c.endedAt?.toISOString().slice(0, 10)).toBe("2026-11-10");
  });

  it("subscription paused marks Paused", async () => {
    await handleStripeEvent(event("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "paused" }), deps());
    expect((await client()).status).toBe("PAUSED");
  });

  it("customer default payment method change updates funding", async () => {
    await handleStripeEvent(event("customer.updated", { id: "cus_1", invoice_settings: { default_payment_method: "pm_1" } }), deps());
    expect((await client()).defaultPaymentFunding).toBe("credit");
  });

  it("unknown customers are skipped without error", async () => {
    expect(await handleStripeEvent(event("invoice.payment_failed", invoice({ id: "in_x", customer: "cus_unknown" })), deps())).toBe("processed");
    expect(await db.invoice.findUnique({ where: { stripeInvoiceId: "in_x" } })).toBeNull();
  });
});
