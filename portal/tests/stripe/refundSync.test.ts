import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { handleStripeEvent, type WebhookDeps } from "@/stripe/webhook";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "./fixtures";

const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
  getPaidMethod: vi.fn(async () => null),
  getPaymentMethodFunding: vi.fn(async () => "credit"),
  onInvoiceCreated: vi.fn(async () => {}),
  onInvoicePaid: vi.fn(async () => {}),
  getInvoiceIdForCharge: vi.fn(async () => "in_1"),
  onRefund: vi.fn(async () => {}),
  ...over,
});

beforeEach(async () => {
  await resetDb();
  await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" } });
});

const paidInvoice = () =>
  invoice({
    status: "paid",
    amount_paid: 82400,
    total: 82400,
    status_transitions: { paid_at: ts("2026-11-15") },
    lines: {
      data: [
        { id: "il_1", amount: 80000, description: "1 × Growth Package", metadata: {} },
        { id: "il_2", amount: 2400, description: "Credit card processing fee (3%)", metadata: { bc_card_fee: "1" } },
      ],
    },
  });

const charge = (refunds: { id: string; amount: number; metadata?: Record<string, string> }[]) => ({
  id: "ch_1",
  object: "charge",
  customer: "cus_1",
  payment_intent: "pi_1",
  amount: 82400,
  amount_refunded: refunds.reduce((n, r) => n + r.amount, 0),
  refunds: { data: refunds.map((r) => ({ ...r, metadata: r.metadata ?? {} })) },
});

describe("onboarding lines", () => {
  it("records the onboarding fee separately", async () => {
    const inv = invoice({
      lines: {
        data: [
          { id: "il_1", amount: 80000, description: "1 × Growth Package", metadata: {} },
          { id: "il_o", amount: 50000, description: "1 × Growth - Onboarding Fee", metadata: {} },
        ],
      },
    });
    await handleStripeEvent(event("invoice.created", inv), deps());
    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } })).onboardingCents).toBe(50000);
  });
});

describe("charge.refunded", () => {
  it("retroactive-discount refund: package share comes from the refund metadata", async () => {
    const d = deps();
    await handleStripeEvent(event("invoice.paid", paidInvoice()), d);
    const c = charge([{ id: "re_1", amount: 20600, metadata: { bc_retro_discount: "1", discountCents: "20000", feeCents: "600" } }]);
    expect(await handleStripeEvent(event("charge.refunded", c), d)).toBe("processed");
    const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(row.refundedCents).toBe(20600);
    expect(d.onRefund).toHaveBeenCalledTimes(1);
    expect(d.onRefund).toHaveBeenCalledWith(row.id, { refundKey: "re_1", refundCents: 20600, packageCents: 20000 });
  });

  it("plain refund: package share is proportional to what was paid", async () => {
    const d = deps();
    await handleStripeEvent(event("invoice.paid", paidInvoice()), d);
    await handleStripeEvent(event("charge.refunded", charge([{ id: "re_2", amount: 41200 }])), d);
    const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(d.onRefund).toHaveBeenCalledWith(row.id, { refundKey: "re_2", refundCents: 41200, packageCents: 40000 });
  });

  it("a second refund on the same charge only reports the new refund", async () => {
    const d = deps();
    await handleStripeEvent(event("invoice.paid", paidInvoice()), d);
    await handleStripeEvent(event("charge.refunded", charge([{ id: "re_a", amount: 10300 }])), d);
    await handleStripeEvent(event("charge.refunded", charge([{ id: "re_a", amount: 10300 }, { id: "re_b", amount: 10300 }])), d);
    const keys = (d.onRefund as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { refundKey: string }).refundKey);
    expect(keys).toEqual(["re_a", "re_b"]);
    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } })).refundedCents).toBe(20600);
  });

  it("the same event delivered twice reports nothing new", async () => {
    const d = deps();
    await handleStripeEvent(event("invoice.paid", paidInvoice()), d);
    const e = event("charge.refunded", charge([{ id: "re_1", amount: 1000 }]), "evt_refund");
    await handleStripeEvent(e, d);
    expect(await handleStripeEvent(e, d)).toBe("duplicate");
    expect(d.onRefund).toHaveBeenCalledTimes(1);
  });

  it("a charge with no invoice, or an invoice the portal doesn't know, is a no-op", async () => {
    const d = deps({ getInvoiceIdForCharge: vi.fn(async () => null) });
    expect(await handleStripeEvent(event("charge.refunded", charge([{ id: "re_x", amount: 100 }])), d)).toBe("processed");
    const d2 = deps({ getInvoiceIdForCharge: vi.fn(async () => "in_unknown") });
    expect(await handleStripeEvent(event("charge.refunded", charge([{ id: "re_y", amount: 100 }])), d2)).toBe("processed");
    expect(d.onRefund).not.toHaveBeenCalled();
    expect(d2.onRefund).not.toHaveBeenCalled();
  });
});
