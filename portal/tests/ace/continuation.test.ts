import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { dueForContinuation, markContinuing, markEnded, onSetupCompleted } from "@/ace/continuation";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "a", email: "a@x.co", name: "A", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

function fakeStripe() {
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_new" })), update: vi.fn(async () => ({})) },
    checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" })) } },
    setupIntents: { retrieve: vi.fn(async () => ({ id: "seti_1", payment_method: "pm_1" })) },
    prices: { create: vi.fn(async () => ({ id: "price_custom" })) },
    subscriptions: { create: vi.fn(async () => ({ id: "sub_new" })) },
  };
}
const stripeRef: { current: ReturnType<typeof fakeStripe> } = { current: fakeStripe() };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const s = () => stripeRef.current;

const DAY = 86400_000;
let growth: string;
let custom: string;

async function aceClient(name: string, daysLeft: number, packageId = growth, customMonthlyCents?: number) {
  const until = new Date(Date.now() + daysLeft * DAY);
  const c = await db.client.create({
    data: { name, email: `${name.replace(/\s/g, "").toLowerCase()}@x.co`, type: "ACE", status: "PREPAID_ACE", acePrepaidUntil: until, packageId },
  });
  const batch = await db.aceBatch.create({ data: { purchasedAt: new Date(), totalCents: 1, createdById: "u", paidAt: new Date() } });
  const slot = await db.aceSlot.create({ data: { batchId: batch.id, packageId, clientId: c.id, startDate: new Date(), prepaidUntil: until, customMonthlyCents: customMonthlyCents ?? null } });
  await db.client.update({ where: { id: c.id }, data: { aceSlotId: slot.id } });
  return c.id;
}

const session = (clientId: string) =>
  ({ id: "cs_1", object: "checkout.session", mode: "setup", customer: "cus_new", setup_intent: "seti_1", metadata: { kind: "ACE_CONTINUATION", clientId } }) as unknown as Stripe.Checkout.Session;

beforeEach(async () => {
  await resetDb();
  stripeRef.current = fakeStripe();
  sessionRef.current = OWNER;
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_growth" } })).id;
  custom = (await db.package.create({ data: { name: "Custom", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: true } })).id;
});

describe("dueForContinuation", () => {
  it("lists ACE clients within 30 days of the end, not those further out", async () => {
    await aceClient("Soon Co", 20);
    await aceClient("Later Co", 60);
    expect((await dueForContinuation()).map((c) => c.name)).toEqual(["Soon Co"]);
  });
});

describe("markContinuing", () => {
  it("creates the client's Stripe customer and a setup link", async () => {
    const id = await aceClient("Soon Co", 20);
    const r = await markContinuing(id, "https://portal.test");
    expect(r).toEqual({ ok: true, setupUrl: "https://checkout.stripe.test/cs_1" });
    expect((s().checkout.sessions.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      mode: "setup",
      customer: "cus_new",
      allowed_payment_method_types: ["card", "us_bank_account"],
      metadata: { kind: "ACE_CONTINUATION", clientId: id },
    });
    const c = await db.client.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ stripeCustomerId: "cus_new", continuationDecision: "CONTINUING", status: "PREPAID_ACE" });
  });
  it("Admins can't", async () => {
    const id = await aceClient("Soon Co", 20);
    sessionRef.current = ADMIN;
    expect((await markContinuing(id, "https://portal.test")).ok).toBe(false);
  });
  it("needs the package linked to a Stripe price", async () => {
    await db.package.update({ where: { id: growth }, data: { stripePriceId: null } });
    const id = await aceClient("Soon Co", 20);
    expect(await markContinuing(id, "https://portal.test")).toEqual({ ok: false, error: "Link this package to a Stripe price in Settings → Packages." });
  });
});

describe("onSetupCompleted", () => {
  it("saves the payment method and starts the subscription the day after the prepaid period, once", async () => {
    const id = await aceClient("Soon Co", 20);
    await markContinuing(id, "https://portal.test");
    await onSetupCompleted(session(id), s() as unknown as Stripe);
    await onSetupCompleted(session(id), s() as unknown as Stripe);
    expect(s().subscriptions.create).toHaveBeenCalledTimes(1);
    const until = (await db.client.findUniqueOrThrow({ where: { id } })).acePrepaidUntil!;
    const [params, opts] = s().subscriptions.create.mock.calls[0] as unknown as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({
      customer: "cus_new",
      items: [{ price: "price_growth" }],
      default_payment_method: "pm_1",
      trial_end: Math.floor(until.getTime() / 1000) + 1,
      metadata: { kind: "ACE_CONTINUATION", clientId: id },
    });
    expect(opts.idempotencyKey).toBe(`bc-ace-sub-${id}`);
    expect(s().customers.update).toHaveBeenCalledWith("cus_new", { invoice_settings: { default_payment_method: "pm_1" } });
    expect((await db.client.findUniqueOrThrow({ where: { id } })).stripeSubscriptionId).toBe("sub_new");
  });

  it("Custom clients get a monthly price at their Custom amount", async () => {
    const id = await aceClient("Custom Co", 20, custom, 200000);
    await markContinuing(id, "https://portal.test");
    await onSetupCompleted(session(id), s() as unknown as Stripe);
    expect((s().prices.create.mock.calls[0] as unknown[])[0]).toMatchObject({ unit_amount: 200000, currency: "usd", recurring: { interval: "month" } });
    expect(((s().subscriptions.create.mock.calls[0] as unknown[])[0] as { items: unknown }).items).toEqual([{ price: "price_custom" }]);
  });
});

describe("status after the prepaid period", () => {
  it("continuing without a payment method yet → Continuing: awaiting payment method", async () => {
    const id = await aceClient("Late Co", 10);
    await markContinuing(id, "https://portal.test");
    await db.client.update({ where: { id }, data: { acePrepaidUntil: new Date(Date.now() - DAY) } });
    expect(await refreshClientStatus(id)).toBe("CONTINUING_AWAITING_PM");
  });
});

describe("markEnded", () => {
  it("ends the client at the end of the prepaid period (still prepaid until then)", async () => {
    const id = await aceClient("Bye Co", 10);
    expect((await markEnded(id)).ok).toBe(true);
    const c = await db.client.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ status: "PREPAID_ACE", continuationDecision: "ENDING" });
    expect(c.endedAt?.getTime()).toBe(c.acePrepaidUntil?.getTime());
    await db.client.update({ where: { id }, data: { acePrepaidUntil: new Date(Date.now() - DAY), endedAt: new Date(Date.now() - DAY) } });
    expect(await refreshClientStatus(id)).toBe("ENDED");
  });
});
