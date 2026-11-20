import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { applyCardFeeToDraft, reconcileCardFee } from "@/stripe/handlers/cardFee";
import { CARD_FEE_DESCRIPTION } from "@/domain/cardFee";
import { resetDb } from "../helpers/db";
import { invoice } from "./fixtures";

const ON = { enabled: true, rateBasisPoints: 300, excludedStates: ["CT"] };

function fakeStripe(pm: { type: string; card?: { funding: string } } | null, state = "TX") {
  return {
    subscriptions: { retrieve: vi.fn(async () => ({ id: "sub_1", default_payment_method: pm ? { id: "pm_1", ...pm } : null })) },
    customers: { retrieve: vi.fn(async () => ({ id: "cus_1", address: { state }, invoice_settings: { default_payment_method: null } })) },
    invoiceItems: { create: vi.fn(async () => ({ id: "ii_1" })) },
    // By default the live invoice equals the event payload; tests override to simulate staleness.
    invoices: { retrieve: vi.fn(async (id: string) => ({ ...(liveInvoices.get(id) as object) })) },
    refunds: { list: vi.fn(async () => ({ data: [] as unknown[] })), create: vi.fn(async () => ({ id: "re_1" })) },
  } as unknown as Stripe & {
    invoiceItems: { create: ReturnType<typeof vi.fn> };
    refunds: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };
}

const liveInvoices = new Map<string, unknown>();
const draft = (over: Record<string, unknown> = {}) => {
  const inv = invoice({ status: "draft", subtotal: 100000, total_discount_amounts: [{ amount: 20000, discount: "di_1" }], ...over });
  liveInvoices.set(inv.id!, inv);
  return inv;
};

beforeEach(async () => {
  await resetDb();
  await db.setting.create({ data: { key: "cardFee", value: ON } });
});

describe("applyCardFeeToDraft", () => {
  it("adds 3% of the discounted amount for a credit card, not discountable", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    expect(await applyCardFeeToDraft(draft(), s)).toBe("added");
    expect(s.invoiceItems.create).toHaveBeenCalledTimes(1);
    expect(s.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "in_1",
        customer: "cus_1",
        amount: 2400, // 3% of $800 (=$1,000 − $200 discount)
        currency: "usd",
        description: CARD_FEE_DESCRIPTION,
        discountable: false,
        metadata: { bc_card_fee: "1" },
      }),
      { idempotencyKey: "bc-card-fee-in_1" },
    );
    expect(await db.auditLog.count({ where: { action: "card_fee_added" } })).toBe(1);
  });

  it("does nothing when the invoice already has a portal fee line (replayed event)", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    const inv = draft({ lines: { data: [{ id: "il_f", amount: 2400, description: CARD_FEE_DESCRIPTION, metadata: { bc_card_fee: "1" } }] } });
    expect(await applyCardFeeToDraft(inv, s)).toBe("skipped_exists");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it("does nothing when the subscription already carries the legacy 3% fee item (no double charge)", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    const inv = draft({ lines: { data: [{ id: "il_l", amount: 1950, description: "1 × 3% Credit Card Fee (at $19.50 / month)", metadata: {} }] } });
    expect(await applyCardFeeToDraft(inv, s)).toBe("skipped_exists");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it("skips non-draft invoices without throwing", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    expect(await applyCardFeeToDraft(draft({ status: "open" }), s)).toBe("skipped_not_draft");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it.each([
    ["debit card", { type: "card", card: { funding: "debit" } }],
    ["ACH", { type: "us_bank_account" }],
    ["no payment method", null],
  ])("skips %s", async (_, pm) => {
    const s = fakeStripe(pm as never);
    expect(await applyCardFeeToDraft(draft(), s)).toBe("skipped_rule");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it("skips excluded states and one-off invoices", async () => {
    expect(await applyCardFeeToDraft(draft(), fakeStripe({ type: "card", card: { funding: "credit" } }, "CT"))).toBe("skipped_rule");
    expect(await applyCardFeeToDraft(draft({ billing_reason: "manual" }), fakeStripe({ type: "card", card: { funding: "credit" } }))).toBe("skipped_rule");
  });

  it("is off by default when no setting exists", async () => {
    await db.setting.deleteMany();
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    expect(await applyCardFeeToDraft(draft(), s)).toBe("skipped_rule");
  });
});

describe("reconcileCardFee", () => {
  const withFee = (over: Record<string, unknown> = {}) =>
    invoice({
      status: "paid",
      lines: {
        data: [
          { id: "il_1", amount: 80000, description: "Growth", metadata: {} },
          { id: "il_f", amount: 2400, description: CARD_FEE_DESCRIPTION, metadata: { bc_card_fee: "1" } },
        ],
      },
      ...over,
    });

  it("refunds the fee when paid by ACH, once", async () => {
    const s = fakeStripe(null);
    expect(await reconcileCardFee(withFee(), { type: "us_bank_account", funding: null, chargeId: "ch_1" }, s)).toBe("refunded");
    expect(s.refunds.create).toHaveBeenCalledWith({ charge: "ch_1", amount: 2400, metadata: { bc_card_fee_refund: "1", invoice: "in_1" } });

    s.refunds.list.mockResolvedValueOnce({ data: [{ id: "re_1", metadata: { bc_card_fee_refund: "1", invoice: "in_1" } }] });
    expect(await reconcileCardFee(withFee(), { type: "us_bank_account", funding: null, chargeId: "ch_1" }, s)).toBe("ok");
    expect(s.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refunds the fee when paid by a debit card", async () => {
    const s = fakeStripe(null);
    expect(await reconcileCardFee(withFee(), { type: "card", funding: "debit", chargeId: "ch_1" }, s)).toBe("refunded");
  });

  it("keeps the fee when paid by credit card", async () => {
    const s = fakeStripe(null);
    expect(await reconcileCardFee(withFee(), { type: "card", funding: "credit", chargeId: "ch_1" }, s)).toBe("ok");
    expect(s.refunds.create).not.toHaveBeenCalled();
  });

  it("logs an uncollected fee when a credit card paid an invoice without one", async () => {
    const s = fakeStripe(null);
    const inv = invoice({ status: "paid" });
    expect(await reconcileCardFee(inv, { type: "card", funding: "credit", chargeId: "ch_1" }, s)).toBe("logged_uncollected");
    expect(await db.auditLog.count({ where: { action: "card_fee_uncollected" } })).toBe(1);
  });

  it("leaves legacy fee items alone (handled at migration)", async () => {
    const s = fakeStripe(null);
    const inv = invoice({ status: "paid", lines: { data: [{ id: "il_l", amount: 1950, description: "1 × 3% Credit Card Fee", metadata: {} }] } });
    expect(await reconcileCardFee(inv, { type: "us_bank_account", funding: null, chargeId: "ch_1" }, s)).toBe("ok");
    expect(s.refunds.create).not.toHaveBeenCalled();
  });

  it("does nothing without a charge (paid out of band)", async () => {
    const s = fakeStripe(null);
    expect(await reconcileCardFee(withFee(), null, s)).toBe("ok");
  });
});

describe("applyCardFeeToDraft: stale or retried events (review C1/I2)", () => {
  it("re-reads the invoice: a retry whose payload predates the fee line adds nothing", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    const stale = draft();
    liveInvoices.set("in_1", { ...stale, lines: { data: [{ id: "il_f", amount: 2400, description: CARD_FEE_DESCRIPTION, metadata: { bc_card_fee: "1" } }], has_more: false } });
    expect(await applyCardFeeToDraft(stale, s)).toBe("skipped_exists");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it("re-reads the invoice: a late invoice.created for an invoice already paid is skipped, not thrown", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    const stale = draft();
    liveInvoices.set("in_1", { ...stale, status: "paid" });
    expect(await applyCardFeeToDraft(stale, s)).toBe("skipped_not_draft");
    expect(s.invoiceItems.create).not.toHaveBeenCalled();
  });

  it("Stripe refusing the item (invoice finalised meanwhile) is a logged skip, not an exception", async () => {
    const s = fakeStripe({ type: "card", card: { funding: "credit" } });
    s.invoiceItems.create.mockRejectedValueOnce(Object.assign(new Error("Invoice is not editable"), { type: "StripeInvalidRequestError" }));
    expect(await applyCardFeeToDraft(draft(), s)).toBe("skipped_not_draft");
    expect(await db.auditLog.count({ where: { action: "card_fee_skipped" } })).toBe(1);
  });
});

