import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { parsePeriod } from "@/domain/periods";
import { upsertInvoiceFromStripe } from "@/stripe/handlers/invoice";
import { recordPaymentCommission } from "@/commissions/engine";
import { onBatchInvoicePaid } from "@/ace/batches";
import { backfillInvoices } from "@/stripe/backfill";
import { monthlyPayments } from "@/payments/monthly";
import { discountsGiven, expectedVsCollected, newClients, revenue } from "@/reports/queries";
import { toCsv } from "@/reports/export";
import { invoice, ts } from "../stripe/fixtures";
import { resetDb } from "../helpers/db";

vi.mock("@/stripe/deps", async (orig) => ({ ...(await orig<object>()), getPaidMethod: async () => null }));

const TZ = "America/New_York";
const nov = parsePeriod("month", "2026-11", TZ);
const dec = parsePeriod("month", "2026-12", TZ);
const d = (s: string) => new Date(s);

beforeEach(resetDb);

describe("#1 bills are filed under the month they're for, not Stripe's look-back period_start", () => {
  it("a renewal invoice created Dec 1 (period_start Nov 1) counts in December", async () => {
    await db.client.create({ data: { name: "A", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    // As Stripe sends it: period_start/end look back one cycle; the line's service period starts Dec 1.
    const withLine = invoice({ id: "in_line", lines: { data: [{ id: "il", amount: 80000, description: "Growth", metadata: {}, period: { start: ts("2026-12-01T14:00:00Z"), end: ts("2027-01-01T14:00:00Z") } }] }, created: ts("2026-12-01T13:00:00Z"), period_start: ts("2026-11-01T14:00:00Z"), period_end: ts("2026-12-01T14:00:00Z") });
    const noLine = invoice({ id: "in_noline", lines: { data: [] }, created: ts("2026-12-02T13:00:00Z"), period_start: ts("2026-11-02T14:00:00Z"), period_end: ts("2026-12-02T14:00:00Z") });
    await upsertInvoiceFromStripe(withLine);
    await upsertInvoiceFromStripe(noLine);
    const rows = await db.invoice.findMany({ orderBy: { stripeInvoiceId: "asc" } });
    expect(rows.map((r) => r.billedAt.toISOString())).toEqual(["2026-12-01T14:00:00.000Z", "2026-12-02T14:00:00.000Z"]);
    expect((await monthlyPayments("2026-12", "OWNER")).rows).toHaveLength(2);
    expect((await monthlyPayments("2026-11", "OWNER")).rows).toHaveLength(0);
    expect((await expectedVsCollected(dec, d("2026-12-20T12:00:00Z"))).expectedCents).toBe(160000);
  });
});

describe("#2 loaded history doesn't change commission", () => {
  it("backfilled paid months don't count on top of 'months before the portal'", async () => {
    const jose = await db.executive.create({ data: { name: "Jose" } });
    const c = await db.client.create({ data: { name: "A", stripeCustomerId: "cus_1", commissionMonthsBeforePortal: 4 } });
    await db.commissionShare.create({ data: { clientId: c.id, executiveId: jose.id, rateBp: 1000, effectiveFrom: d("2020-01-01"), createdById: "u" } });
    for (let m = 1; m <= 4; m++) {
      await upsertInvoiceFromStripe(invoice({ id: `in_hist${m}`, status: "paid", amount_paid: 80000, status_transitions: { paid_at: ts(`2026-0${m}-01T15:00:00Z`), finalized_at: 1 } }), { backfilled: true });
    }
    let earned = 0;
    for (let m = 5; m <= 13; m++) {
      const month = String(((m - 1) % 12) + 1).padStart(2, "0");
      const year = m > 12 ? 2027 : 2026;
      const row = await upsertInvoiceFromStripe(invoice({ id: `in_new${m}`, status: "paid", amount_paid: 80000, status_transitions: { paid_at: ts(`${year}-${month}-01T15:00:00Z`), finalized_at: 1 } }));
      earned += await recordPaymentCommission(row!.id) > 0 ? 1 : 0;
    }
    expect(earned).toBe(8); // months 5–12 of the 12-month window
    expect(await db.invoice.count({ where: { backfilled: true } })).toBe(4);
  });
});

describe("#3 ACE paying a batch by credit card", () => {
  it("records the 3% fee on the batch and reports it as card fees", async () => {
    const b = await db.aceBatch.create({ data: { purchasedAt: d("2026-11-01T12:00:00Z"), totalCents: 5000000, createdById: "u" } });
    await onBatchInvoicePaid(invoice({ id: "in_ace", customer: "cus_ace", status: "paid", metadata: { kind: "ACE_BATCH", batchId: b.id }, status_transitions: { paid_at: ts("2026-11-15T15:00:00Z"), finalized_at: 1 }, lines: { data: [{ id: "a", amount: 5000000, description: "ACE", metadata: {} }, { id: "f", amount: 150000, description: "3% Credit Card Fee", metadata: { bc_card_fee: "1" } }] } }));
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: b.id } })).cardFeeCents).toBe(150000);
    const r = await revenue(nov);
    expect(r.types).toMatchObject({ aceCents: 5000000, cardFeesCents: 150000, totalCents: 5150000 });
  });
});

describe("#4 retroactive discounts count as discounts given", () => {
  it("adds them by the date they were given", async () => {
    const c = await db.client.create({ data: { name: "A" } });
    const inv = await db.invoice.create({ data: { stripeInvoiceId: "in_1", clientId: c.id, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, periodStart: d("2026-10-05T12:00:00Z"), periodEnd: d("2026-11-05T12:00:00Z"), billedAt: d("2026-10-05T12:00:00Z") } });
    await db.auditLog.create({ data: { action: "discount_retroactive", entity: "Invoice", entityId: inv.id, after: { amountCents: 5000 }, at: d("2026-11-12T15:00:00Z") } });
    expect(await discountsGiven(nov)).toEqual({ totalCents: 5000, byClient: [{ name: "A", cents: 5000 }] });
  });
});

describe("#5 history includes clients who left, and start dates come from Stripe", () => {
  it("creates ended clients for fully cancelled customers, skips ACE and one-off customers, and records start dates", async () => {
    await db.setting.create({ data: { key: "ace", value: { stripeCustomerId: "cus_ace" } } });
    await db.client.create({ data: { name: "Current", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    const pages = [{ has_more: false, data: [
      invoice({ id: "in_a", customer: "cus_1", status: "paid", amount_paid: 1, status_transitions: { paid_at: ts("2025-02-01T15:00:00Z"), finalized_at: 1 } }),
      invoice({ id: "in_gone", customer: "cus_gone", status: "paid", amount_paid: 1, status_transitions: { paid_at: ts("2025-03-01T15:00:00Z"), finalized_at: 1 } }),
      invoice({ id: "in_ace", customer: "cus_ace", status: "paid" }),
      invoice({ id: "in_oneoff", customer: "cus_oneoff", status: "paid" }),
    ] }];
    const subs: Record<string, unknown[]> = {
      cus_gone: [{ id: "sub_gone", status: "canceled", start_date: ts("2024-06-01T12:00:00Z"), ended_at: ts("2025-08-01T12:00:00Z"), customer: "cus_gone" }],
      cus_oneoff: [],
      cus_ace: [],
    };
    const stripe = {
      invoices: { list: vi.fn(async () => pages[0]) },
      subscriptions: {
        list: vi.fn(async (p: { customer: string }) => ({ data: subs[p.customer] ?? [], has_more: false })),
        retrieve: vi.fn(async (id: string) => ({ id, status: "active", start_date: ts("2023-03-15T12:00:00Z") })),
      },
      customers: { retrieve: vi.fn(async (id: string) => ({ id, name: id === "cus_gone" ? "Gone LLC" : id, email: null })) },
    } as unknown as Stripe;
    expect(await backfillInvoices(stripe, d("2025-01-01"))).toMatchObject({ stored: 2, clientsAdded: 1 });
    const gone = await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_gone" } });
    expect(gone).toMatchObject({ name: "Gone LLC", status: "ENDED", endedAt: d("2025-08-01T12:00:00Z"), startedAt: d("2024-06-01T12:00:00Z") });
    expect((await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_1" } })).startedAt).toEqual(d("2023-03-15T12:00:00Z"));
    expect(await db.client.count({ where: { stripeCustomerId: { in: ["cus_ace", "cus_oneoff"] } } })).toBe(0);
    // Existing clients are not "new" in the first loaded month.
    expect((await newClients(parsePeriod("month", "2025-02", TZ))).total).toBe(0);
  });
});

describe("#6 past due", () => {
  const mk = async (o: Record<string, unknown>, client: Record<string, unknown> = {}) => {
    const c = await db.client.create({ data: { name: `C${Math.random()}`, ...client } });
    return db.invoice.create({ data: { stripeInvoiceId: `in_${Math.random()}`, clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1000, totalCents: 1000, periodStart: d("2026-10-01T12:00:00Z"), periodEnd: d("2026-11-01T12:00:00Z"), ...o } });
  };
  it("leaves out ended clients, brand-new bills, and emailed invoices not yet due", async () => {
    const asOf = d("2026-11-20T12:00:00Z");
    await mk({ billedAt: d("2026-11-10T12:00:00Z") }); // autopay, 10 days unpaid → past due
    await mk({ billedAt: d("2026-11-20T11:00:00Z") }); // created an hour ago
    await mk({ billedAt: d("2026-11-01T12:00:00Z"), dueAt: d("2026-12-01T12:00:00Z") }); // emailed, due next month
    await mk({ billedAt: d("2026-10-01T12:00:00Z"), dueAt: d("2026-10-31T12:00:00Z") }); // emailed, overdue
    await mk({ billedAt: d("2026-06-01T12:00:00Z") }, { endedAt: d("2026-07-01T12:00:00Z") }); // client left
    expect((await expectedVsCollected(nov, asOf)).outstandingPastDueCents).toBe(2000);
  });
});

describe("CSV keeps money as numbers", () => {
  it("doesn't put an apostrophe before negative amounts, but still guards formulas", () => {
    expect(toCsv([{ title: "T", columns: ["a"], rows: [["-$100.00"], ["−$5.00"], ["-12.5%"], ["-cmd|x"], ["=1+1"]] }])).toBe('"T"\r\n"a"\r\n"-$100.00"\r\n"-$5.00"\r\n"-12.5%"\r\n"\'-cmd|x"\r\n"\'=1+1"\r\n');
  });
});
