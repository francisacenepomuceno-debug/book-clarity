import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { backfillInvoices } from "@/stripe/backfill";
import { invoice } from "../stripe/fixtures";
import { resetDb } from "../helpers/db";

beforeEach(resetDb);

describe("invoice history backfill (read-only)", () => {
  it("pages through Stripe, stores known clients' invoices once, and never writes to Stripe", async () => {
    await db.client.create({ data: { name: "A", stripeCustomerId: "cus_1" } });
    const pages = [
      { data: [invoice({ id: "in_a", status: "paid", amount_paid: 80000, status_transitions: { paid_at: 1790000000, finalized_at: 1790000000 } }), invoice({ id: "in_b", status: "open" })], has_more: true },
      { data: [invoice({ id: "in_c", customer: "cus_unknown" }), invoice({ id: "in_d", status: "open", attempt_count: 2 })], has_more: false },
    ];
    const list = vi.fn(async (p: { starting_after?: string }) => (p.starting_after ? pages[1] : pages[0]));
    const paymentsList = vi.fn(async () => ({ data: [{ payment: { charge: { id: "ch_1", payment_method_details: { type: "card", card: { funding: "credit" } } } } }] }));
    // Only read methods exist on this fake: any write would throw.
    const stripe = { invoices: { list }, invoicePayments: { list: paymentsList } } as unknown as Stripe;

    const first = await backfillInvoices(stripe, new Date("2025-01-01T00:00:00Z"));
    expect(first).toEqual({ seen: 4, stored: 3, skipped: 1 });
    expect(list.mock.calls[0][0]).toMatchObject({ limit: 100, created: { gte: Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000) } });
    expect(list.mock.calls[1][0]).toMatchObject({ starting_after: "in_b" });
    const rows = await db.invoice.findMany({ orderBy: { stripeInvoiceId: "asc" } });
    expect(rows.map((r) => r.stripeInvoiceId)).toEqual(["in_a", "in_b", "in_d"]);
    expect(rows[0]).toMatchObject({ status: "paid", paymentMethodType: "card", cardFunding: "credit" });
    // History never starts reminder clocks: an old failed invoice gets no firstFailedAt.
    expect(rows[2].firstFailedAt).toBeNull();

    await backfillInvoices(stripe, new Date("2025-01-01T00:00:00Z"));
    expect(await db.invoice.count()).toBe(3);
    expect(await db.notification.count()).toBe(0);
  });
});
