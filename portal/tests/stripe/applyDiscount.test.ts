import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { applyDiscount, applyRetroactiveDiscount } from "@/billing/discounts";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const stripeRef: { current: unknown } = { current: null };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));

function fakeStripe() {
  return {
    subscriptions: {
      retrieve: vi.fn(async function (this: { liveDiscounts: unknown[] }) { return {
        id: "sub_1",
        discounts: (stripeRef.current as { subscriptions: { liveDiscounts: unknown[] } }).subscriptions.liveDiscounts,
        items: {
          data: [
            { price: { unit_amount: 65000, product: { name: "Growth Package" } }, quantity: 1 },
            { price: { unit_amount: 1950, product: { name: "3% Credit Card Fee" } }, quantity: 1 },
          ],
        },
      }; }),
      update: vi.fn(async () => ({ id: "sub_1" })),
      // current discounts on the live subscription (may include ones set in the Stripe dashboard)
      liveDiscounts: [] as unknown[],
    },
    coupons: { create: vi.fn(async (p: { id: string }) => ({ id: p.id })) },
    invoices: { retrieve: vi.fn(async () => ({ id: "in_1" })) },
    invoicePayments: {
      list: vi.fn(async () => ({
        data: [{ payment: { payment_intent: { latest_charge: { id: "ch_1", payment_method_details: { type: "card", card: { funding: "credit" } } } } } }],
      })),
    },
    refunds: { create: vi.fn(async () => ({ id: `re_${Math.random()}` })) },
  };
}

let clientId: string;
let owner: { id: string };
beforeEach(async () => {
  await resetDb();
  owner = await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER", totpEnabled: true } });
  const c = await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" } });
  clientId = c.id;
  stripeRef.current = fakeStripe();
  sessionRef.current = { user: { ...owner, email: "jose@bc.test", name: "Jose", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
});
const s = () => stripeRef.current as ReturnType<typeof fakeStripe>;

describe("applyDiscount", () => {
  it("Owner: creates the coupon, attaches it, records the discount and audit", async () => {
    const r = await applyDiscount(clientId, { kind: "PERCENT", percentOff: 20, months: 3, reason: "Jose approved" });
    expect(r.ok).toBe(true);
    const couponArgs = s().coupons.create.mock.calls[0][0];
    expect(couponArgs).toMatchObject({ percent_off: 20, duration: "repeating", duration_in_months: 3, metadata: { reason: "Jose approved", clientId } });
    expect(s().subscriptions.update).toHaveBeenCalledWith("sub_1", { discounts: [{ coupon: couponArgs.id }] }, { idempotencyKey: `bc-sub-discount-${couponArgs.id}` });
    const rows = await db.discount.findMany({ where: { clientId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "PERCENT", percentOff: 20, months: 3, createdById: owner.id, replacedAt: null });
    expect(await db.auditLog.count({ where: { action: "discount_applied", entityId: clientId } })).toBe(1);
  });

  it("validates against the package price only (not the card fee)", async () => {
    const r = await applyDiscount(clientId, { kind: "AMOUNT", amountOffCents: 66000, months: 1, reason: "x" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("monthly") });
    expect(s().coupons.create).not.toHaveBeenCalled();
  });

  it("replaces an existing discount and keeps it in the audit 'before'", async () => {
    await applyDiscount(clientId, { kind: "PERCENT", percentOff: 10, months: 2, reason: "first" });
    await applyDiscount(clientId, { kind: "AMOUNT", amountOffCents: 5000, months: 1, reason: "second" });
    const rows = await db.discount.findMany({ where: { clientId }, orderBy: { createdAt: "asc" } });
    expect(rows[0].replacedAt).not.toBeNull();
    expect(rows[1].replacedAt).toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "discount_applied" }, orderBy: { at: "desc" } });
    expect(audit.before).toMatchObject({ reason: "first", percentOff: 10 });
  });

  it("Admin is refused and Stripe is never called", async () => {
    sessionRef.current = { user: { id: "a1", email: "a@bc.test", name: "Alex", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };
    const r = await applyDiscount(clientId, { kind: "PERCENT", percentOff: 20, months: 3, reason: "x" });
    expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(s().coupons.create).not.toHaveBeenCalled();
    expect(s().subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("applyRetroactiveDiscount", () => {
  beforeEach(async () => {
    await db.invoice.create({
      data: {
        stripeInvoiceId: "in_1", clientId, status: "paid", kind: "SUBSCRIPTION",
        subtotalCents: 80000, totalCents: 82400, cardFeeCents: 2400, amountPaidCents: 82400,
        periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01"),
      },
    });
  });

  it("refunds the amount plus the proportional card fee on that invoice's charge", async () => {
    const inv = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    const r = await applyRetroactiveDiscount(inv.id, { amountCents: 20000, reason: "Make-good" });
    expect(r.ok).toBe(true);
    // 25% of the $800 package → 25% of the $24 fee = $6.00
    expect(s().refunds.create).toHaveBeenCalledWith({
      charge: "ch_1",
      amount: 20600,
      metadata: { bc_retro_discount: "1", invoice: "in_1", discountCents: "20000", feeCents: "600", reason: "Make-good" },
    }, { idempotencyKey: expect.stringMatching(/^bc-retro-/) });
    expect(await db.auditLog.count({ where: { action: "discount_retroactive" } })).toBe(1);
  });

  it("cannot exceed the package amount paid", async () => {
    const inv = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    const r = await applyRetroactiveDiscount(inv.id, { amountCents: 80001, reason: "x" });
    expect(r.ok).toBe(false);
    expect(s().refunds.create).not.toHaveBeenCalled();
  });
});

describe("review I4/I5: discount safety", () => {
  it("records discounts set directly in Stripe in the audit 'before'", async () => {
    s().subscriptions.liveDiscounts = [{ id: "di_dash", source: { coupon: { id: "DASH20", percent_off: 20 } } }];
    await applyDiscount(clientId, { kind: "PERCENT", percentOff: 10, months: 2, reason: "x" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "discount_applied" } });
    expect(audit.before).toMatchObject({ stripeDiscounts: [{ id: "di_dash" }] });
  });

  it("two simultaneous submissions leave exactly one active discount", async () => {
    await Promise.all([
      applyDiscount(clientId, { kind: "PERCENT", percentOff: 10, months: 2, reason: "a" }),
      applyDiscount(clientId, { kind: "PERCENT", percentOff: 15, months: 2, reason: "b" }),
    ]);
    expect(await db.discount.count({ where: { clientId, replacedAt: null } })).toBe(1);
  });

  it("uses idempotency keys for the Stripe writes", async () => {
    await applyDiscount(clientId, { kind: "PERCENT", percentOff: 10, months: 2, reason: "x" });
    expect((s().coupons.create.mock.calls[0] as unknown[])[1]).toMatchObject({ idempotencyKey: expect.stringMatching(/^bc-coupon-/) });
    expect((s().subscriptions.update.mock.calls[0] as unknown[])[2]).toMatchObject({ idempotencyKey: expect.stringMatching(/^bc-sub-discount-/) });
  });

  it("rejects a reason over 500 characters before touching Stripe", async () => {
    const r = await applyDiscount(clientId, { kind: "PERCENT", percentOff: 10, months: 2, reason: "x".repeat(501) });
    expect(r.ok).toBe(false);
    expect(s().coupons.create).not.toHaveBeenCalled();
  });

  it("retroactive discounts on one invoice can't add up to more than the package paid", async () => {
    await db.invoice.create({
      data: {
        stripeInvoiceId: "in_9", clientId, status: "paid", kind: "SUBSCRIPTION",
        subtotalCents: 80000, totalCents: 80000, amountPaidCents: 80000,
        periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-12-01"),
      },
    });
    const inv = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_9" } });
    const [a, b] = await Promise.all([
      applyRetroactiveDiscount(inv.id, { amountCents: 50000, reason: "first" }),
      applyRetroactiveDiscount(inv.id, { amountCents: 50000, reason: "second" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await applyRetroactiveDiscount(inv.id, { amountCents: 30000, reason: "third" })).ok).toBe(true);
    expect((await applyRetroactiveDiscount(inv.id, { amountCents: 1, reason: "fourth" })).ok).toBe(false);
  });
});

