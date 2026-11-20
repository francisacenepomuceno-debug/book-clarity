import type Stripe from "stripe";

export const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export function invoice(over: Partial<Record<string, unknown>> = {}): Stripe.Invoice {
  return {
    id: "in_1",
    object: "invoice",
    customer: "cus_1",
    status: "open",
    billing_reason: "subscription_cycle",
    subtotal: 80000,
    total: 80000,
    amount_paid: 0,
    amount_remaining: 80000,
    total_discount_amounts: [],
    period_start: ts("2026-11-01"),
    period_end: ts("2026-12-01"),
    created: ts("2026-12-01"),
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
    lines: { data: [{ id: "il_1", amount: 80000, description: "1 × Growth Package (at $800.00 / month)", metadata: {} }] },
    status_transitions: { paid_at: null, finalized_at: ts("2026-12-01") },
    metadata: {},
    ...over,
  } as unknown as Stripe.Invoice;
}

export function event(type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`): Stripe.Event {
  return { id, type, data: { object }, object: "event" } as unknown as Stripe.Event;
}
