import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { renameClient, separateCompany } from "@/clients/companies";
import { clientForStripe } from "@/clients/subscriptions";
import { syncClientsFromSnapshot, withPricing } from "@/clients/queries";
import { commissionProgress } from "@/commissions/statements";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@bc.test", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

// Ivan Shammas: one Stripe customer, two companies on Essentials, plus one AR/AP package shared by both.
const HP = "sub_hispanic_plug";
const MM = "sub_mundo_media";
const ARAP = "sub_arap";
let ivan = "";
let ess = "";
let n = 0;
const row = (sub: string, name = "Ivan Shammas"): LiveClientRow => ({
  customerId: "cus_I", subscriptionId: sub, name, email: "ivan@x.co", status: "CURRENT", packageName: "Essentials",
  sixMonthContract: false, packageMonthlyCents: 35000, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true, paymentMethod: "ACH",
  nextChargeDate: null, amountDueCents: 0, pastDueSince: null,
});

beforeEach(async () => {
  await resetDb();
  n = 0;
  await db.user.create({ data: { id: "u1", email: "u@bc.test", name: "U", role: "OWNER" } });
  ess = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } })).id;
  ivan = (await db.client.create({ data: { name: "Ivan Shammas", stripeCustomerId: "cus_I", stripeSubscriptionId: HP, packageId: ess, status: "CURRENT" } })).id;
  await db.clientSubscription.create({ data: { clientId: ivan, stripeSubscriptionId: HP, packageId: ess } });
  await db.clientSubscription.create({ data: { clientId: ivan, stripeSubscriptionId: MM, packageId: ess, commissionMonthsBeforePortal: 4 } });
  await db.clientSubscription.create({ data: { clientId: ivan, stripeSubscriptionId: ARAP } });
  const jose = await db.executive.create({ data: { name: "Jose" } });
  await db.commissionShare.create({ data: { clientId: ivan, executiveId: jose.id, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });
  as("OWNER");
});

async function paid(sub: string) {
  n += 1;
  return db.invoice.create({ data: { stripeInvoiceId: `in_${n}`, clientId: ivan, stripeSubscriptionId: sub, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 35000, totalCents: 35000, amountPaidCents: 35000, paidAt: new Date("2026-10-01"), periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-01") } });
}

describe("several companies sharing one Stripe customer", () => {
  it("separating a package makes it its own company, with its invoices, commission lines, split and months", async () => {
    const inv = await paid(MM);
    await paid(HP);
    await db.commissionEntry.create({ data: { executiveId: (await db.executive.findFirstOrThrow()).id, clientId: ivan, invoiceId: inv.id, kind: "EARNED", windowIndex: 5, baseCents: 35000, rateBp: 1000, amountCents: 3500, occurredAt: new Date("2026-10-01"), month: "2026-10" } });

    const r = await separateCompany(MM, "Mundo Media");
    expect(r.ok).toBe(true);
    const mm = await db.client.findFirstOrThrow({ where: { companyName: "Mundo Media" } });
    expect(mm).toMatchObject({ stripeCustomerId: "cus_I", stripeSubscriptionId: MM, packageId: ess, type: "DIRECT", commissionMonthsBeforePortal: 4 });
    expect(await db.invoice.count({ where: { clientId: mm.id } })).toBe(1);
    expect(await db.invoice.count({ where: { clientId: ivan } })).toBe(1);
    expect(await db.commissionEntry.count({ where: { clientId: mm.id } })).toBe(1);
    expect(await db.commissionShare.count({ where: { clientId: mm.id } })).toBe(1);
    expect((await db.client.findUniqueOrThrow({ where: { id: ivan } })).stripeSubscriptionId).toBe(HP);

    // Stripe events for that subscription now reach the new company; others stay with the first.
    expect((await clientForStripe("cus_I", MM))?.id).toBe(mm.id);
    expect((await clientForStripe("cus_I", ARAP))?.id).toBe(ivan);
    expect((await clientForStripe("cus_I", null))?.id).toBe(ivan);
    // Each company has its own main window; AR/AP stays an additional package of the first.
    expect((await commissionProgress(mm.id)).otherPackages).toEqual([]);
    expect((await commissionProgress(ivan)).otherPackages.map((o) => o.subscriptionId)).toEqual([ARAP]);
  });

  it("separating the client's main package works: another package becomes the first company's main one", async () => {
    await db.client.update({ where: { id: ivan }, data: { commissionMonthsBeforePortal: 3 } });
    await db.clientSubscription.update({ where: { stripeSubscriptionId: MM }, data: { commissionMonthsBeforePortal: 4 } });
    await paid(HP);
    const r = await separateCompany(HP, "Hispanic Plug");
    expect(r.ok).toBe(true);
    const hp = await db.client.findFirstOrThrow({ where: { companyName: "Hispanic Plug" } });
    // The moved main package keeps its months (3) and package; the old client's new main is the next package, with its own months (4).
    expect(hp).toMatchObject({ stripeSubscriptionId: HP, packageId: ess, commissionMonthsBeforePortal: 3 });
    expect(await db.invoice.count({ where: { clientId: hp.id } })).toBe(1);
    const old = await db.client.findUniqueOrThrow({ where: { id: ivan } });
    expect([MM, ARAP]).toContain(old.stripeSubscriptionId);
    expect(old.commissionMonthsBeforePortal).toBe(old.stripeSubscriptionId === MM ? 4 : 0);
    expect((await db.clientSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: old.stripeSubscriptionId! } })).commissionMonthsBeforePortal).toBe(0);
  });

  it("names: each company keeps its own company name; the contact stays Stripe's customer name", async () => {
    await separateCompany(MM, "Mundo Media");
    expect(await renameClient(ivan, "Hispanic Plug")).toEqual({ ok: true });
    await syncClientsFromSnapshot([row(HP), row(MM), row(ARAP)]);
    // Each company keeps its own company name; the contact person stays Stripe's customer name.
    const both = await db.client.findMany({ where: { stripeCustomerId: "cus_I" }, orderBy: { companyName: "asc" } });
    expect(both.map((c) => [c.companyName, c.name])).toEqual([["Hispanic Plug", "Ivan Shammas"], ["Mundo Media", "Ivan Shammas"]]);
    expect((await withPricing([row(HP), row(MM)])).map((r) => r.companyName)).toEqual(["Hispanic Plug", "Mundo Media"]);
    // A business name in Stripe only fills a missing company name.
    await syncClientsFromSnapshot([{ ...row(HP), companyName: "From Stripe" }]);
    expect((await db.client.findUniqueOrThrow({ where: { id: ivan } })).companyName).toBe("Hispanic Plug");
  });

  it("refuses for a client's only package, and for Admins", async () => {
    await db.clientSubscription.updateMany({ where: { stripeSubscriptionId: { in: [MM, ARAP] } }, data: { endedAt: new Date() } });
    expect(await separateCompany(HP, "X")).toMatchObject({ ok: false, error: expect.stringMatching(/only package/) });
    as("ADMIN");
    expect((await separateCompany(MM, "Y")).ok).toBe(false);
    expect((await renameClient(ivan, "Z")).ok).toBe(false);
  });
});

describe("company names on the dashboard and in the import", () => {
  it("a new client from Stripe takes Stripe's business name as its company; the import can set it", async () => {
    await resetDb();
    await db.user.create({ data: { id: "u1", email: "u@bc.test", name: "U", role: "SUPER_ADMIN" } });
    as("SUPER_ADMIN");
    await syncClientsFromSnapshot([{ ...row("sub_x", "Pat Lee"), customerId: "cus_x", companyName: "Lee Plumbing" }, { ...row("sub_y", "Sam Roe"), customerId: "cus_y" }]);
    expect((await db.client.findMany({ orderBy: { name: "asc" } })).map((c) => [c.name, c.companyName])).toEqual([["Pat Lee", "Lee Plumbing"], ["Sam Roe", null]]);
    const { planImport, applyImport } = await import("@/migration/commissionImport");
    const plan = await planImport("client,company\ncus_y,Roe Roofing LLC\n", { createMissingExecutives: false });
    expect(plan.ready[0].companyName).toBe("Roe Roofing LLC");
    await applyImport(plan.ready);
    expect((await db.client.findFirstOrThrow({ where: { stripeCustomerId: "cus_y" } })).companyName).toBe("Roe Roofing LLC");
    // Rows can then be matched by company name too.
    expect((await planImport("client,months_already_earned\nRoe Roofing LLC,2\n", { createMissingExecutives: false })).ready).toHaveLength(1);
  });
});
