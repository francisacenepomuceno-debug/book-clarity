import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { recordPaymentCommission, recomputeClient } from "@/commissions/engine";
import { setClientCommission } from "@/commissions/splits";
import { handleStripeEvent, type WebhookDeps } from "@/stripe/webhook";
import { recordRefundClawback } from "@/commissions/engine";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "../stripe/fixtures";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

let clientId: string;
let jose: string;
let albert: string;
let n = 0;
async function paid(paidAt: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return db.invoice.create({
    data: {
      stripeInvoiceId: `in_${n}`, clientId, status: "paid", kind: "SUBSCRIPTION",
      subtotalCents: 80000, totalCents: 80000, amountPaidCents: 80000, paidAt: new Date(paidAt),
      periodStart: new Date(paidAt), periodEnd: new Date(paidAt), ...extra,
    },
  });
}
const amountsBy = async () => (await db.commissionEntry.findMany()).map((e) => [e.executiveId === jose ? "jose" : "albert", e.amountCents]);

beforeEach(async () => {
  await resetDb();
  n = 0;
  sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
  clientId = (await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  albert = (await db.executive.create({ data: { name: "Albert" } })).id;
});

describe("C1: a backdated or same-day split change never pays twice", () => {
  it("an invoice that already earned keeps its original lines", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    await recordPaymentCommission((await paid("2026-03-10T15:00:00Z")).id);
    await setClientCommission(clientId, { shares: [{ executiveId: albert, ratePercent: 10 }], effectiveFrom: new Date("2026-03-01") });
    expect(await amountsBy()).toEqual([["jose", 8000]]);
  });
});

describe("C2: correcting a split on the same date replaces it", () => {
  it("only the latest version for that date earns", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    await setClientCommission(clientId, { shares: [{ executiveId: albert, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    await recordPaymentCommission((await paid("2026-03-10T15:00:00Z")).id);
    expect(await amountsBy()).toEqual([["albert", 8000]]);
  });
});

describe("I3: refunds recorded before an owner was assigned reduce the base", () => {
  it("a fully refunded month earns nothing and doesn't use a window month", async () => {
    await paid("2026-03-10T15:00:00Z", { refundedCents: 80000, refundedPackageCents: 80000 });
    await paid("2026-04-10T15:00:00Z");
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    const rows = await db.commissionEntry.findMany();
    expect(rows.map((r) => [r.amountCents, r.windowIndex])).toEqual([[8000, 1]]);
  });
  it("a half-refunded month earns on the remaining half", async () => {
    await paid("2026-03-10T15:00:00Z", { refundedCents: 40000, refundedPackageCents: 40000 });
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    expect((await db.commissionEntry.findMany()).map((r) => r.amountCents)).toEqual([4000]);
  });
});

describe("I4: a clawback isn't lost when the first attempt fails", () => {
  it("Stripe's retry still claws back", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    const paidInv = invoice({ status: "paid", amount_paid: 80000, total: 80000, status_transitions: { paid_at: ts("2026-11-15") } });
    let fail = true;
    const deps: WebhookDeps = {
      getPaidMethod: async () => null,
      getPaymentMethodFunding: async () => null,
      onInvoiceCreated: async () => {},
      onInvoicePaid: async (inv) => {
        const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: inv.id! } });
        await recordPaymentCommission(row.id);
      },
      getInvoiceIdForCharge: async () => "in_1",
      onRefund: async (rowId, r) => {
        if (fail) { fail = false; throw new Error("db blip"); }
        await recordRefundClawback(rowId, { refundKey: r.refundKey, packageCents: r.packageCents });
      },
    };
    await handleStripeEvent(event("invoice.paid", paidInv), deps);
    const charge = { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1", amount: 80000, amount_refunded: 80000, refunds: { data: [{ id: "re_1", amount: 80000, metadata: {} }] } };
    const e = event("charge.refunded", charge, "evt_r");
    await expect(handleStripeEvent(e, deps)).rejects.toThrow("db blip");
    await handleStripeEvent(e, deps);
    expect((await db.commissionEntry.findMany({ orderBy: { createdAt: "asc" } })).map((x) => x.amountCents)).toEqual([8000, -8000]);
  });
});

describe("I5: never more than the window, whatever order payments arrive in", () => {
  it("an earlier-dated payment arriving late can't make a 13th earning month", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 10 } });
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    const a = await paid("2026-09-10T15:00:00Z");
    const c = await paid("2026-11-10T15:00:00Z");
    await recordPaymentCommission(a.id);
    await recordPaymentCommission(c.id);
    const b = await paid("2026-10-10T15:00:00Z"); // delivered late
    await recordPaymentCommission(b.id);
    await recomputeClient(clientId);
    expect(await db.commissionEntry.count({ where: { kind: "EARNED" } })).toBe(2);
  });
});

describe("I6: taxes are not commissionable", () => {
  it("the base excludes tax", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01") });
    await recordPaymentCommission((await paid("2026-03-10T15:00:00Z", { amountPaidCents: 86400, totalCents: 86400, taxCents: 6400 })).id);
    expect((await db.commissionEntry.findMany()).map((r) => r.baseCents)).toEqual([80000]);
  });
  it("tax on a Stripe invoice is recorded", async () => {
    await handleStripeEvent(
      event("invoice.created", invoice({ total_taxes: [{ amount: 6400, tax_behavior: "exclusive" }] })),
      { getPaidMethod: async () => null, getPaymentMethodFunding: async () => null, onInvoiceCreated: async () => {}, onInvoicePaid: async () => {} },
    );
    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } })).taxCents).toBe(6400);
  });
});
