import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { onboardingLink } from "@/onboarding/start";
import { onboardingPayOptions, onOnboardingFeeFailed, onOnboardingFeePaid, onOnboardingSetupSucceeded, startOnboardingPayment } from "@/onboarding/payment";
import { nextStep } from "@/domain/onboarding";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
let invoiceCount = 0;
let payResult: () => Promise<{ status: string }>;
const stripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_new" })), update: vi.fn(async () => ({})), retrieve: vi.fn(async () => ({ id: "cus_new", address: { state: "TX" } })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" })) } },
  setupIntents: { retrieve: vi.fn() },
  invoices: {
    create: vi.fn(async () => ({ id: `in_${++invoiceCount}` })),
    finalizeInvoice: vi.fn(async () => ({})),
    pay: vi.fn(async () => payResult()),
    retrieve: vi.fn(async (id: string) => ({ id, status: "open" })),
    voidInvoice: vi.fn(async () => ({})),
  },
  invoiceItems: { create: vi.fn(async () => ({})) },
  prices: { retrieve: vi.fn(async () => ({ id: "price_c", product: "prod_custom" })) },
  subscriptions: { create: vi.fn(async () => ({ id: "sub_new", status: "trialing" })) },
};
const s = stripe as unknown as Stripe;

let onbId = "";
let token = "";
async function setup(o: { feeCents?: number; custom?: boolean } = {}) {
  await db.setting.create({ data: { key: "cardFee", value: { enabled: true } } });
  const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_g", isCustom: o.custom ?? false } });
  const c = await db.client.create({ data: { name: "Acme LLC", email: "a@acme.co", packageId: p.id } });
  const ob = await db.onboarding.create({
    data: { clientId: c.id, packageId: p.id, monthlyCents: o.custom ? 250000 : 65000, onboardingFeeCents: o.feeCents ?? 50000, signedAt: now, details: { business: "Acme LLC", firstName: "J", signerName: "J D", phone: "1", address1: "a", address2: "", city: "Austin", state: "TX", zip: "1" } },
  });
  onbId = ob.id;
  token = onboardingLink(ob.id, "https://p").split("/onboard/")[1];
}
const si = (pm: { type: string; funding?: string }, id = "seti_1") => {
  stripe.setupIntents.retrieve.mockResolvedValue({ id, status: "succeeded", customer: "cus_new", payment_method: { id: "pm_1", type: pm.type, card: pm.funding ? { funding: pm.funding } : undefined } });
  return { id, object: "setup_intent", status: "succeeded", customer: "cus_new", payment_method: "pm_1", metadata: { kind: "ONBOARDING_SETUP", onboardingId: onbId } } as unknown as Stripe.SetupIntent;
};
const paidInvoice = (paidAt: Date, id = "in_1") =>
  ({ id, customer: "cus_new", status: "paid", metadata: { kind: "ONBOARDING", onboardingId: onbId }, status_transitions: { paid_at: Math.floor(paidAt.getTime() / 1000) } }) as unknown as Stripe.Invoice;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  invoiceCount = 0;
  payResult = async () => ({ status: "paid" });
  ghl.upsert.mockResolvedValue("ct");
  ghl.send.mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("onboarding fee", () => {
  it("shows the fee and the 3% credit-card amount", async () => {
    await setup();
    expect(await onboardingPayOptions(token)).toMatchObject({ feeCents: 50000, creditCardFeeCents: 1500 });
  });

  it("opens a Stripe setup page for the chosen method, creating the customer once", async () => {
    await setup();
    expect(await startOnboardingPayment(token, "bank", "https://p", s)).toEqual({ url: "https://checkout.stripe.test/cs_1" });
    await startOnboardingPayment(token, "card", "https://p", s);
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    const calls = stripe.checkout.sessions.create.mock.calls as unknown as [Stripe.Checkout.SessionCreateParams][];
    expect(calls[0][0]).toMatchObject({ mode: "setup", customer: "cus_new", allowed_payment_method_types: ["us_bank_account"], setup_intent_data: { metadata: { kind: "ONBOARDING_SETUP", onboardingId: onbId } } });
    expect(calls[1][0].allowed_payment_method_types).toEqual(["card"]);
  });

  it("a credit card adds 3%; a debit card doesn't", async () => {
    await setup();
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "credit" }), s);
    const items = (stripe.invoiceItems.create.mock.calls as unknown as [Stripe.InvoiceItemCreateParams][]).map((c) => c[0].amount);
    expect(items).toEqual([50000, 1500]);
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: onbId } })).feeSubmittedAt).not.toBeNull();

    await resetDb(); vi.clearAllMocks(); await setup();
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    expect((stripe.invoiceItems.create.mock.calls as unknown as [Stripe.InvoiceItemCreateParams][]).map((c) => c[0].amount)).toEqual([50000]);
  });

  it("a declined card leaves the client on the payment step", async () => {
    await setup();
    payResult = async () => { throw new Error("Your card was declined."); };
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    const o = await db.onboarding.findUniqueOrThrow({ where: { id: onbId }, include: { client: true } });
    expect(o.feeSubmittedAt).toBeNull();
    expect(nextStep(o, "DIRECT")).toBe("payment");
    expect(await onboardingPayOptions(token)).toMatchObject({ declined: true });
  });

  it("the same setup event twice makes one invoice; a fresh setup voids the old unpaid invoice", async () => {
    await setup();
    payResult = async () => { throw new Error("declined"); };
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    expect(stripe.invoices.create).toHaveBeenCalledTimes(1);
    payResult = async () => ({ status: "paid" });
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }, "seti_2"), s);
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith("in_1");
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: onbId } })).feeInvoiceId).toBe("in_2");
  });

  it("ACH: the client moves on while the payment clears; billing starts 14 days after it clears", async () => {
    await setup();
    payResult = async () => ({ status: "open" }); // processing
    await onOnboardingSetupSucceeded(si({ type: "us_bank_account" }), s);
    let o = await db.onboarding.findUniqueOrThrow({ where: { id: onbId } });
    expect(nextStep(o, "DIRECT")).toBe("intake");
    const cleared = new Date(now.getTime() + 4 * DAY);
    await onOnboardingFeePaid(paidInvoice(cleared), s);
    o = await db.onboarding.findUniqueOrThrow({ where: { id: onbId } });
    expect(o.feePaidAt).toEqual(cleared);
    const sub = (stripe.subscriptions.create.mock.calls[0] as unknown as [Stripe.SubscriptionCreateParams, Stripe.RequestOptions])[0];
    expect(sub.trial_end).toBe(Math.floor((cleared.getTime() + 14 * DAY) / 1000));
    expect(sub.items).toEqual([{ price: "price_g" }]);
    expect(sub.default_payment_method).toBe("pm_1");
  });

  it("paying twice (duplicate webhooks) creates one subscription", async () => {
    await setup();
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    await onOnboardingFeePaid(paidInvoice(now), s);
    await onOnboardingFeePaid(paidInvoice(now), s);
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    const opts = (stripe.subscriptions.create.mock.calls[0] as unknown as [unknown, Stripe.RequestOptions])[1];
    expect(opts.idempotencyKey).toBe(`bc-onb-sub-${onbId}`);
    const o = await db.onboarding.findUniqueOrThrow({ where: { id: onbId }, include: { client: true } });
    expect(o.client.stripeSubscriptionId).toBe("sub_new");
  });

  it("a Custom package bills its per-client price", async () => {
    await setup({ custom: true });
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "debit" }), s);
    await onOnboardingFeePaid(paidInvoice(now), s);
    const sub = (stripe.subscriptions.create.mock.calls[0] as unknown as [Stripe.SubscriptionCreateParams])[0];
    expect(sub.items).toEqual([{ price_data: { currency: "usd", product: "prod_custom", unit_amount: 250000, recurring: { interval: "month" } } }]);
  });

  it("no onboarding fee: saving the method starts billing 14 days later", async () => {
    await setup({ feeCents: 0 });
    await onOnboardingSetupSucceeded(si({ type: "card", funding: "credit" }), s);
    expect(stripe.invoices.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
  });

  it("a bank payment that fails later sends the client back to the payment step", async () => {
    await setup();
    payResult = async () => ({ status: "open" });
    await onOnboardingSetupSucceeded(si({ type: "us_bank_account" }), s);
    await onOnboardingFeeFailed({ id: "in_1", metadata: { kind: "ONBOARDING", onboardingId: onbId } } as unknown as Stripe.Invoice);
    const o = await db.onboarding.findUniqueOrThrow({ where: { id: onbId } });
    expect(nextStep(o, "DIRECT")).toBe("payment");
    expect((await db.notification.findMany()).map((n) => n.key)).toEqual([`onboarding-fee-failed:in_1`]);
  });
});

describe("webhook routing", () => {
  it("routes onboarding events and never sends the monthly 'payment failed' notice for the fee", async () => {
    const { handleStripeEvent } = await import("@/stripe/webhook");
    const { event, invoice } = await import("../stripe/fixtures");
    await setup();
    await db.client.updateMany({ data: { stripeCustomerId: "cus_1" } });
    const deps = {
      getPaidMethod: async () => null, getPaymentMethodFunding: async () => null, onInvoiceCreated: async () => {}, onInvoicePaid: async () => {},
      onOnboardingSetupSucceeded: vi.fn(), onOnboardingFeePaid: vi.fn(), onOnboardingFeeFailed: vi.fn(), onPaymentFailedNotice: vi.fn(async (id: string) => { const { onPaymentFailedNotice } = await import("@/notify/payments"); await onPaymentFailedNotice(id); }),
    };
    await handleStripeEvent(event("setup_intent.succeeded", { id: "seti_1", metadata: { kind: "ONBOARDING_SETUP", onboardingId: onbId } }), deps);
    const fee = invoice({ id: "in_f", parent: null, billing_reason: "manual", metadata: { kind: "ONBOARDING", onboardingId: onbId } });
    await handleStripeEvent(event("invoice.payment_failed", fee), deps);
    await handleStripeEvent(event("invoice.paid", { ...fee, status: "paid" }), deps);
    expect(deps.onOnboardingSetupSucceeded).toHaveBeenCalledTimes(1);
    expect(deps.onOnboardingFeeFailed).toHaveBeenCalledTimes(1);
    expect(deps.onOnboardingFeePaid).toHaveBeenCalledTimes(1);
    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_f" } })).kind).toBe("ONBOARDING");
    expect(await db.notification.count()).toBe(0);
  });
});
