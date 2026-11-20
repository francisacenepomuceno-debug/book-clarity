import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { startOnboarding, onboardingLink } from "@/onboarding/start";
import { choosePackage, loadOnboarding } from "@/onboarding/steps";
import { onOnboardingFeeFailed, onOnboardingSetupSucceeded } from "@/onboarding/payment";
import { resumeClient, runSuspensions } from "@/billing/suspension";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  ghl.upsert.mockResolvedValue("ct");
  ghl.send.mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("#1 a bank payment that bounces after onboarding finished", () => {
  it("reopens the payment step and tells Owners", async () => {
    await db.user.create({ data: { id: "jose", email: "jose@bc.test", name: "Jose", role: "OWNER" } });
    const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co" } });
    const o = await db.onboarding.create({ data: { clientId: c.id, packageId: "p", details: {}, signedAt: now, feeInvoiceId: "in_1", feeSubmittedAt: now, intakeAt: now, callBookedAt: now, completedAt: now, onboardingFeeCents: 50000 } });
    await db.package.create({ data: { id: "p", name: "Growth", monthlyPriceCents: 1, onboardingFeeCents: 1, stripePriceId: "price_g" } });
    await onOnboardingFeeFailed({ id: "in_1", metadata: { kind: "ONBOARDING", onboardingId: o.id } } as unknown as Stripe.Invoice);
    const l = await loadOnboarding(onboardingLink(o.id, "https://p").split("/onboard/")[1]);
    expect("error" in l ? l.error : l.step).toBe("payment");
    expect((await db.notification.findMany()).map((n) => n.key)).toContain(`onboarding-fee-failed-staff:in_1:jose`);
  });
  it("completes again once a new payment goes through", async () => {
    const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co", stripeCustomerId: "cus_1" } });
    const o = await db.onboarding.create({ data: { clientId: c.id, packageId: "p", details: {}, signedAt: now, intakeAt: now, callBookedAt: now, onboardingFeeCents: 50000, feeInvoiceId: "in_old" } });
    const stripe = {
      setupIntents: { retrieve: vi.fn(async () => ({ id: "seti_2", customer: "cus_1", payment_method: { id: "pm", type: "card", card: { funding: "debit" } } })) },
      customers: { update: vi.fn(), retrieve: vi.fn(async () => ({ id: "cus_1", address: null })) },
      invoices: { retrieve: vi.fn(async () => ({ id: "in_old", status: "void" })), create: vi.fn(async () => ({ id: "in_2" })), finalizeInvoice: vi.fn(), pay: vi.fn(async () => ({ status: "paid" })), voidInvoice: vi.fn() },
      invoiceItems: { create: vi.fn() },
    };
    await onOnboardingSetupSucceeded({ id: "seti_2", metadata: { onboardingId: o.id } } as unknown as Stripe.SetupIntent, stripe as unknown as Stripe);
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).completedAt).not.toBeNull();
  });
});

describe("#2 an Owner's manual Resume sticks", () => {
  it("the next daily run doesn't suspend for the same unpaid invoice; a later failure still can", async () => {
    const stripe = { subscriptions: { update: vi.fn(async () => ({})) } } as unknown as Stripe;
    const c = await db.client.create({ data: { name: "A", email: "a@x.co", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    await db.invoice.create({ data: { stripeInvoiceId: "in_x", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(now.getTime() - 31 * DAY), periodStart: now, periodEnd: now } });
    expect(await runSuspensions(now, stripe)).toBe(1);
    as("OWNER");
    expect((await resumeClient(c.id, stripe)).ok).toBe(true);
    expect(await runSuspensions(new Date(now.getTime() + DAY), stripe)).toBe(0);
    const later = new Date(now.getTime() + 40 * DAY);
    await db.invoice.create({ data: { stripeInvoiceId: "in_y", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(later.getTime() - 5 * DAY), periodStart: later, periodEnd: later } });
    expect(await runSuspensions(new Date(later.getTime() + 30 * DAY), stripe)).toBe(1);
  });
});

describe("#3/#5 onboarding fee and custom price", () => {
  it("an Owner's fee override is kept when the client chooses the package", async () => {
    as("OWNER");
    const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_g" } });
    const r = await startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT", onboardingFeeCents: 0 });
    if (!r.ok) throw new Error(r.error);
    await db.onboarding.update({ where: { id: r.onboardingId }, data: {} });
    await choosePackage(r.url.split("/onboard/")[1], p.id, now);
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: r.onboardingId } })).onboardingFeeCents).toBe(0);
  });
  it("Admins can't set prices", async () => {
    as("ADMIN");
    const p = await db.package.create({ data: { name: "Custom", monthlyPriceCents: 0, onboardingFeeCents: 1, isCustom: true, stripePriceId: "price_c" } });
    expect((await startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT", onboardingFeeCents: 0 })).ok).toBe(false);
    expect((await startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT", packageId: p.id, customMonthlyCents: 100 })).ok).toBe(false);
    expect((await startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT" })).ok).toBe(true);
  });
});

describe("#4 ACE clients need a package", () => {
  it("refuses an ACE start without one", async () => {
    as("OWNER");
    expect((await startOnboarding({ name: "A", email: "a@x.co", type: "ACE" })).ok).toBe(false);
  });
});

describe("#9 packages without a Stripe price", () => {
  it("can't be used for a Direct client (they'd never be billed monthly)", async () => {
    as("OWNER");
    const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000 } });
    expect((await startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT", packageId: p.id })).ok).toBe(false);
    const r = await startOnboarding({ name: "B", email: "b@x.co", type: "DIRECT" });
    if (!r.ok) throw new Error(r.error);
    expect((await choosePackage(r.url.split("/onboard/")[1], p.id, now)).ok).toBe(false);
  });
});

describe("#10 the fee invoice names the saved payment method type", () => {
  it("sets payment_settings for ACH", async () => {
    const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co", stripeCustomerId: "cus_1" } });
    const o = await db.onboarding.create({ data: { clientId: c.id, packageId: "p", details: {}, signedAt: now, onboardingFeeCents: 50000 } });
    const create = vi.fn(async () => ({ id: "in_1" }));
    const stripe = {
      setupIntents: { retrieve: vi.fn(async () => ({ id: "seti", customer: "cus_1", payment_method: { id: "pm", type: "us_bank_account" } })) },
      customers: { update: vi.fn(), retrieve: vi.fn(async () => ({ id: "cus_1", address: null })) },
      invoices: { create, finalizeInvoice: vi.fn(), pay: vi.fn(async () => ({ status: "open" })) },
      invoiceItems: { create: vi.fn() },
    };
    await onOnboardingSetupSucceeded({ id: "seti", metadata: { onboardingId: o.id } } as unknown as Stripe.SetupIntent, stripe as unknown as Stripe);
    expect((create.mock.calls[0] as unknown as [Stripe.InvoiceCreateParams])[0].payment_settings).toEqual({ payment_method_types: ["us_bank_account"] });
  });
});

describe("#11 one Stripe error doesn't stop the suspension run", () => {
  it("suspends the other clients", async () => {
    const update = vi.fn(async (id: string) => { if (id === "sub_bad") throw new Error("No such subscription"); return {}; });
    for (const sub of ["sub_bad", "sub_ok"]) {
      const c = await db.client.create({ data: { name: sub, stripeCustomerId: `cus_${sub}`, stripeSubscriptionId: sub } });
      await db.invoice.create({ data: { stripeInvoiceId: `in_${sub}`, clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(now.getTime() - (sub === "sub_bad" ? 40 : 35) * DAY), periodStart: now, periodEnd: now } });
    }
    expect(await runSuspensions(now, { subscriptions: { update } } as unknown as Stripe)).toBe(1);
  });
});
