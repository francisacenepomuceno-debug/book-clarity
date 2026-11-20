import { describe, expect, it } from "vitest";
import { mapSubscription } from "@/stripe/mapSubscription";

const now = new Date("2026-11-20T12:00:00Z");
const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const products = new Map([
  ["prod_ess", "Essentials Package"],
  ["prod_fee", "3% Credit Card Fee"],
]);

function sub(over: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    collection_method: "charge_automatically",
    discounts: [],
    default_payment_method: null,
    customer: {
      id: "cus_1",
      name: "Acme LLC",
      email: "a@acme.test",
      invoice_settings: { default_payment_method: { type: "card", card: { funding: "credit" } } },
      default_source: null,
    },
    items: {
      data: [
        { price: { product: "prod_ess", unit_amount: 35000 }, quantity: 1, current_period_end: ts("2026-12-01") },
        { price: { product: "prod_fee", unit_amount: 1050 }, quantity: 1, current_period_end: ts("2026-12-01") },
      ],
    },
    latest_invoice: { status: "paid", attempt_count: 1, amount_remaining: 0, due_date: null, created: ts("2026-11-01"), status_transitions: { finalized_at: ts("2026-11-01") } },
    ...over,
  } as never;
}

describe("mapSubscription", () => {
  it("separates package revenue from the card fee", () => {
    const r = mapSubscription(sub(), products, now);
    expect(r.packageName).toBe("Essentials");
    expect(r.packageMonthlyCents).toBe(35000);
    expect(r.cardFeeMonthlyCents).toBe(1050);
    expect(r.paymentMethod).toBe("Credit card");
    expect(r.status).toBe("CURRENT");
    expect(r.nextChargeDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("past_due subscription with an open invoice is PAST_DUE, dated from finalization", () => {
    const r = mapSubscription(
      sub({ status: "past_due", latest_invoice: { status: "open", attempt_count: 0, amount_remaining: 36050, due_date: null, created: ts("2026-11-10"), status_transitions: { finalized_at: ts("2026-11-10") } } }),
      products,
      now,
    );
    expect(r.status).toBe("PAST_DUE");
    expect(r.amountDueCents).toBe(36050);
    expect(r.pastDueSince?.toISOString().slice(0, 10)).toBe("2026-11-10");
  });

  it("open invoice failing 21+ days is AT_RISK", () => {
    const r = mapSubscription(
      sub({ status: "past_due", latest_invoice: { status: "open", attempt_count: 3, amount_remaining: 100, due_date: null, created: ts("2026-10-25"), status_transitions: { finalized_at: ts("2026-10-25") } } }),
      products,
      now,
    );
    expect(r.status).toBe("AT_RISK");
  });

  it("paused subscription has no next charge", () => {
    const r = mapSubscription(sub({ status: "paused" }), products, now);
    expect(r.status).toBe("PAUSED");
    expect(r.nextChargeDate).toBeNull();
  });

  it("falls back to 'None on file' and labels debit and ACH", () => {
    const none = sub();
    (none as any).customer.invoice_settings.default_payment_method = null;
    expect(mapSubscription(none, products, now).paymentMethod).toBe("None on file");
    expect(mapSubscription(sub({ default_payment_method: { type: "card", card: { funding: "debit" } } }), products, now).paymentMethod).toBe("Debit card");
    expect(mapSubscription(sub({ default_payment_method: { type: "us_bank_account" } }), products, now).paymentMethod).toBe("ACH");
  });

  it("counts quantity and unknown products as Other", () => {
    const r = mapSubscription(
      sub({ items: { data: [{ price: { product: "prod_x", unit_amount: 20000 }, quantity: 2, current_period_end: ts("2026-12-05") }] } }),
      new Map([["prod_x", "AR/AP SCope"]]),
      now,
    );
    expect(r.packageName).toBe("Other: AR/AP SCope");
    expect(r.packageMonthlyCents).toBe(40000);
  });

  it("labels emailed-invoice billing instead of 'None on file'", () => {
    const none = sub({ collection_method: "send_invoice" });
    (none as any).customer.invoice_settings.default_payment_method = null;
    const r = mapSubscription(none, products, now);
    expect(r.autopay).toBe(false);
    expect(r.paymentMethod).toBe("Emailed invoice");
    const withCard = mapSubscription(sub({ collection_method: "send_invoice" }), products, now);
    expect(withCard.paymentMethod).toBe("Emailed invoice (Credit card on file)");
    expect(mapSubscription(sub(), products, now).autopay).toBe(true);
  });
});
