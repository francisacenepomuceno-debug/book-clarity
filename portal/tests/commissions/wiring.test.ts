import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { handleStripeEvent } from "@/stripe/webhook";
import { defaultWebhookDeps } from "@/stripe/deps";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "../stripe/fixtures";

const fakeStripe = {
  invoicePayments: {
    list: vi.fn(async (p: { invoice?: string; payment?: { payment_intent: string } }) =>
      p.payment
        ? { data: [{ invoice: "in_1" }] }
        : { data: [{ payment: { payment_intent: { latest_charge: { id: "ch_1", payment_method_details: { type: "us_bank_account" } } } } }] },
    ),
  },
  refunds: { list: vi.fn(async () => ({ data: [] })), create: vi.fn() },
};
vi.mock("@/stripe/client", () => ({ getStripe: () => fakeStripe }));

beforeEach(async () => {
  await resetDb();
  const c = await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" } });
  const jose = await db.executive.create({ data: { name: "Jose" } });
  await db.commissionShare.create({ data: { clientId: c.id, executiveId: jose.id, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u" } });
});

describe("webhook → commission ledger", () => {
  it("invoice.paid earns commission and charge.refunded claws it back", async () => {
    const paid = invoice({ status: "paid", amount_paid: 80000, total: 80000, status_transitions: { paid_at: ts("2026-11-15") } });
    await handleStripeEvent(event("invoice.paid", paid), defaultWebhookDeps());
    expect((await db.commissionEntry.findMany()).map((e) => e.amountCents)).toEqual([8000]);

    const charge = { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1", amount: 80000, amount_refunded: 40000, refunds: { data: [{ id: "re_1", amount: 40000, metadata: {} }] } };
    await handleStripeEvent(event("charge.refunded", charge), defaultWebhookDeps());
    expect((await db.commissionEntry.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.amountCents)).toEqual([8000, -4000]);
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
  });
});
