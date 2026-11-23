import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { recordPaymentCommission } from "@/commissions/engine";
import { commissionProgress } from "@/commissions/statements";
import { onSubscriptionChanged } from "@/stripe/handlers/subscription";
import { syncClientsFromSnapshot, withPricing } from "@/clients/queries";
import { linkClientPackage, revertToListPrice, setMainSubscription } from "@/billing/pricing";
import { runPriceChanges, schedulePriceIncrease } from "@/billing/priceChanges";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import { fillInvoiceSubscriptions } from "@/clients/invoiceSubscriptions";
import { setPackageMonthsBeforePortal } from "@/commissions/splits";
import { applyImport, planImport } from "@/migration/commissionImport";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const stripeRef: { current: unknown } = { current: null };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const ghl = vi.hoisted(() => ({ upsert: vi.fn(async () => "ct"), send: vi.fn(async () => "m") }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "jose@bc.test", name: "Jose", role, totpEnabled: true }, twoFactorVerified: true });

// Shavonn's shape: bookkeeping (Growth) billed on the 1st, a Custom AR/AP package billed on the 15th.
const GROWTH_SUB = "sub_growth";
const ARAP_SUB = "sub_arap";
let clientId = "";
let growth = "";
let arap = "";
let jose = "";
let n = 0;

async function paid(sub: string | null, paidAt: string, cents: number) {
  n += 1;
  return db.invoice.create({
    data: { stripeInvoiceId: `in_${n}`, clientId, stripeSubscriptionId: sub, status: "paid", kind: "SUBSCRIPTION", subtotalCents: cents, totalCents: cents, amountPaidCents: cents, paidAt: new Date(paidAt), periodStart: new Date(paidAt), periodEnd: new Date(paidAt) },
  });
}

const row = (sub: string, cents: number, name: string): LiveClientRow => ({
  customerId: "cus_S", subscriptionId: sub, name: "Shavonn Richardson", email: "s@x.co", status: "CURRENT", packageName: name,
  sixMonthContract: false, packageMonthlyCents: cents, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true, paymentMethod: "ACH",
  nextChargeDate: null, amountDueCents: 0, pastDueSince: null,
});

beforeEach(async () => {
  await resetDb();
  n = 0;
  await db.user.create({ data: { id: "u1", email: "jose@bc.test", name: "Jose", role: "OWNER" } });
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_growth" } })).id;
  arap = (await db.package.create({ data: { name: "Custom AR/AP", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: true } })).id;
  clientId = (await db.client.create({ data: { name: "Shavonn Richardson", stripeCustomerId: "cus_S", stripeSubscriptionId: GROWTH_SUB, packageId: growth, status: "CURRENT" } })).id;
  await db.clientSubscription.create({ data: { clientId, stripeSubscriptionId: GROWTH_SUB, packageId: growth } });
  await db.clientSubscription.create({ data: { clientId, stripeSubscriptionId: ARAP_SUB, packageId: arap } });
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  await db.commissionShare.create({ data: { clientId, executiveId: jose, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u" } });
  as("OWNER");
});

describe("a client with two packages billed on different days", () => {
  it("each package has its own commission window; 'months already earned' applies to the main package only", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 6 } });
    let growthEarned = 0;
    let arapEarned = 0;
    for (let m = 1; m <= 14; m++) {
      const y = m > 12 ? 2028 : 2027;
      const mm = String(((m - 1) % 12) + 1).padStart(2, "0");
      growthEarned += (await recordPaymentCommission((await paid(GROWTH_SUB, `${y}-${mm}-01T15:00:00Z`, 65000)).id)) > 0 ? 1 : 0;
      arapEarned += (await recordPaymentCommission((await paid(ARAP_SUB, `${y}-${mm}-15T15:00:00Z`, 60000)).id)) > 0 ? 1 : 0;
    }
    expect(growthEarned).toBe(6); // the 6 months left after the 6 already earned
    expect(arapEarned).toBe(12); // its own 12 paid months
    const p = await commissionProgress(clientId);
    expect(p).toMatchObject({ windowMonths: 12, earnedMonths: 12, remainingMonths: 0, mainPackageName: "Growth" });
    expect(p.otherPackages).toEqual([{ subscriptionId: ARAP_SUB, packageName: "Custom AR/AP", ended: false, monthsBeforePortal: 0, windowMonths: 12, earnedMonths: 12, remainingMonths: 0 }]);
  });

  it("older invoices with no subscription recorded count toward the main package", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 11 } });
    expect(await recordPaymentCommission((await paid(null, "2027-01-01T15:00:00Z", 65000)).id)).toBeGreaterThan(0);
    expect(await recordPaymentCommission((await paid(GROWTH_SUB, "2027-02-01T15:00:00Z", 65000)).id)).toBe(0); // window full
    expect(await recordPaymentCommission((await paid(ARAP_SUB, "2027-02-15T15:00:00Z", 60000)).id)).toBeGreaterThan(0);
  });

  it("the Stripe sync records every subscription with its package", async () => {
    await db.clientSubscription.deleteMany();
    await syncClientsFromSnapshot([row(GROWTH_SUB, 65000, "Growth"), row(ARAP_SUB, 60000, "Other: AR/AP SCope")]);
    const subs = await db.clientSubscription.findMany({ orderBy: { stripeSubscriptionId: "asc" } });
    expect(subs.map((s) => [s.stripeSubscriptionId, s.packageId])).toEqual([[ARAP_SUB, null], [GROWTH_SUB, growth]]);
    // An Owner links AR/AP by hand; the main package (the client's) doesn't change.
    expect(await linkClientPackage(clientId, arap, ARAP_SUB)).toEqual({ ok: true });
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).packageId).toBe(growth);
    await syncClientsFromSnapshot([row(GROWTH_SUB, 65000, "Growth"), row(ARAP_SUB, 60000, "Other: AR/AP SCope")]);
    expect((await db.clientSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: ARAP_SUB } })).packageId).toBe(arap);
  });

  it("dashboard rows: each subscription shows its own package and discount state", async () => {
    const rows = await withPricing([row(GROWTH_SUB, 50000, "Growth"), row(ARAP_SUB, 60000, "Other: AR/AP SCope")]);
    expect(rows.map((r) => [r.packageName, r.listPriceCents, r.discounted])).toEqual([
      ["Growth", 65000, true],
      ["Custom AR/AP", null, false], // Custom: no list price to compare
    ]);
  });

  it("the client stays active while any package is still running; ends when all have", async () => {
    const sub = (id: string, status: string) => ({ id, customer: "cus_S", status, ended_at: status === "canceled" ? 1790000000 : null }) as unknown as Stripe.Subscription;
    await onSubscriptionChanged(sub(GROWTH_SUB, "canceled"), true);
    let c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(c).toMatchObject({ endedAt: null, stripeSubscriptionId: ARAP_SUB, packageId: arap });
    expect((await db.clientSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: GROWTH_SUB } })).endedAt).not.toBeNull();
    await onSubscriptionChanged(sub(ARAP_SUB, "canceled"), true);
    c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(c.endedAt).not.toBeNull();
    expect(c.status).toBe("ENDED");
    // A new package later makes them a client again.
    await onSubscriptionChanged(sub("sub_new", "active"), false);
    c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(c).toMatchObject({ endedAt: null, stripeSubscriptionId: "sub_new" });
  });

  it("revert and price increases act on the right subscription", async () => {
    const calls: { id: string; params: unknown }[] = [];
    const subData = (id: string, amount: number, product: string, periodEnd = "2027-01-20T15:00:00Z") => ({
      id, status: "active", discounts: [], default_payment_method: { type: "us_bank_account" }, customer: { id: "cus_S" },
      items: { data: [{ id: `si_${id}`, quantity: 1, current_period_end: Math.floor(new Date(periodEnd).getTime() / 1000), price: { id: `price_${amount}`, unit_amount: amount, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { id: "prod", name: product } } }] },
    });
    // A second client whose only (main) subscription is Growth, plus Shavonn's extra AR/AP on a Growth-priced plan for this test.
    stripeRef.current = {
      subscriptions: {
        retrieve: vi.fn(async (id: string) => (id === GROWTH_SUB ? subData(id, 50000, "Growth Package") : subData(id, 65000, "Growth Package"))),
        update: vi.fn(async (id: string, params: unknown) => { calls.push({ id, params }); return {}; }),
      },
      prices: { retrieve: vi.fn(async () => ({ id: "price_growth", product: "prod", currency: "usd", recurring: { interval: "month", interval_count: 1 } })), create: vi.fn(async () => ({ id: "price_new" })) },
    };
    // Revert on the main (discounted to $500) subscription changes only that one.
    expect(await revertToListPrice(clientId, GROWTH_SUB)).toMatchObject({ ok: true });
    expect(calls.map((c) => c.id)).toEqual([GROWTH_SUB]);
    // An extra subscription on the package is moved by a price increase too.
    await db.clientSubscription.update({ where: { stripeSubscriptionId: ARAP_SUB }, data: { packageId: growth } });
    calls.length = 0;
    await schedulePriceIncrease({ packageId: growth, newMonthlyCents: 70000, startsOn: "2027-01-01" }, new Date("2026-11-22T15:00:00Z"));
    await runPriceChanges(new Date("2026-12-21T15:00:00Z"));
    expect(calls.map((c) => c.id)).toEqual([ARAP_SUB]); // the main one is at $500 (custom), so it's left alone
  });

  it("an Owner can make another subscription the main package; Admins can't", async () => {
    as("ADMIN");
    expect((await setMainSubscription(clientId, ARAP_SUB)).ok).toBe(false);
    as("OWNER");
    expect(await setMainSubscription(clientId, ARAP_SUB)).toEqual({ ok: true });
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(c).toMatchObject({ stripeSubscriptionId: ARAP_SUB, packageId: arap });
    // The old main keeps its package on its own row.
    expect((await db.clientSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: GROWTH_SUB } })).packageId).toBe(growth);
    expect(await setMainSubscription(clientId, "sub_unknown")).toMatchObject({ ok: false });
  });

  it("older invoices of multi-package clients get their subscription filled in from Stripe", async () => {
    const a = await paid(null, "2026-10-01T15:00:00Z", 65000);
    const b = await paid(null, "2026-10-15T15:00:00Z", 60000);
    const retrieve = vi.fn(async (id: string) => ({ id, parent: { subscription_details: { subscription: id === a.stripeInvoiceId ? GROWTH_SUB : ARAP_SUB } } }));
    expect(await fillInvoiceSubscriptions(300, { invoices: { retrieve } } as unknown as Stripe)).toBe(2);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).stripeSubscriptionId).toBe(GROWTH_SUB);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: b.id } })).stripeSubscriptionId).toBe(ARAP_SUB);
    expect(await fillInvoiceSubscriptions(300, { invoices: { retrieve } } as unknown as Stripe)).toBe(0);
  });

  it("an additional package can have months already earned (Shavonn's AR/AP: 7), so it earns for 5 more", async () => {
    expect(await setPackageMonthsBeforePortal(ARAP_SUB, 7)).toEqual({ ok: true });
    expect((await setPackageMonthsBeforePortal(GROWTH_SUB, 3)).ok).toBe(false); // the main package uses the client's setting
    as("ADMIN");
    expect((await setPackageMonthsBeforePortal(ARAP_SUB, 1)).ok).toBe(false);
    as("OWNER");
    let arapEarned = 0;
    for (let m = 1; m <= 8; m++) arapEarned += (await recordPaymentCommission((await paid(ARAP_SUB, `2027-0${m}-15T15:00:00Z`, 60000)).id)) > 0 ? 1 : 0;
    expect(arapEarned).toBe(5);
    const other = (await commissionProgress(clientId)).otherPackages[0];
    expect(other).toMatchObject({ monthsBeforePortal: 7, earnedMonths: 12, remainingMonths: 0 });
  });

  it("the import sets an additional package's months by its subscription ID", async () => {
    const plan = await planImport(`client,months_already_earned\n${ARAP_SUB},7\n${GROWTH_SUB},6`, { createMissingExecutives: false });
    expect(plan.problems).toEqual([]);
    expect(plan.ready.map((r) => [r.clientName, r.packageSubscriptionId ?? null, r.monthsBeforePortal])).toEqual([
      ["Shavonn Richardson (additional package)", ARAP_SUB, 7],
      ["Shavonn Richardson", null, 6],
    ]);
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 2, failed: [] });
    expect((await db.clientSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: ARAP_SUB } })).commissionMonthsBeforePortal).toBe(7);
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).commissionMonthsBeforePortal).toBe(6);
    const bad = await planImport(`client,executive_1,rate_1,months_already_earned\n${ARAP_SUB},Jose,10,7`, { createMissingExecutives: false });
    expect(bad.problems[0].error).toMatch(/only months_already_earned/);
  });
});
