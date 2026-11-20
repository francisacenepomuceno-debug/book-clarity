import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { resumeClient, resumeIfPaidUp, runSuspensions } from "@/billing/suspension";
import { deriveClientStatus } from "@/domain/clientStatus";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
const stripe = { subscriptions: { update: vi.fn(async () => ({})) } };
const s = stripe as unknown as Stripe;

async function failing(daysAgo: number, over: Record<string, unknown> = {}) {
  const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co", stripeCustomerId: `cus_${Math.random()}`, stripeSubscriptionId: `sub_${Math.random()}`, status: "PAST_DUE", ...over } });
  const inv = await db.invoice.create({ data: { stripeInvoiceId: `in_${Math.random()}`, clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 65000, totalCents: 65000, firstFailedAt: new Date(now.getTime() - daysAgo * DAY), periodStart: now, periodEnd: now } });
  return { c, inv };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  ghl.upsert.mockResolvedValue("ct");
  ghl.send.mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
  await db.user.create({ data: { id: "jose", email: "jose@bc.test", name: "Jose", role: "OWNER" } });
  await db.user.create({ data: { id: "alex", email: "alex@bc.test", name: "Alex", role: "ADMIN" } });
});

describe("auto-suspension", () => {
  it("suspends on day 30, not day 29, and only once", async () => {
    const day30 = await failing(30);
    const day29 = await failing(29);
    expect(await runSuspensions(now, s)).toBe(1);
    expect(await runSuspensions(now, s)).toBe(0);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update.mock.calls[0]).toEqual([
      day30.c.stripeSubscriptionId,
      { pause_collection: { behavior: "void" }, metadata: { bc_suspended: "1" } },
      { idempotencyKey: `bc-suspend-${day30.inv.stripeInvoiceId}` },
    ]);
    const c = await db.client.findUniqueOrThrow({ where: { id: day30.c.id } });
    expect(c).toMatchObject({ suspendedAt: now, status: "SUSPENDED" });
    expect((await db.client.findUniqueOrThrow({ where: { id: day29.c.id } })).suspendedAt).toBeNull();
    const keys = (await db.notification.findMany()).map((n) => n.key).sort();
    expect(keys).toEqual([`suspended:${day30.inv.id}`, `suspended-staff:${day30.inv.id}:alex`, `suspended-staff:${day30.inv.id}:jose`].sort());
  });

  it("uses the configured number of days", async () => {
    await db.setting.create({ data: { key: "onboarding", value: { suspendAfterDays: 45 } } });
    await failing(40);
    expect(await runSuspensions(now, s)).toBe(0);
  });

  it("never suspends ACE-prepaid, ended, or bank-payment-processing clients", async () => {
    await failing(40, { type: "ACE", acePrepaidUntil: new Date(now.getTime() + 30 * DAY) });
    await failing(40, { endedAt: now });
    const p = await failing(40);
    await db.invoice.update({ where: { id: p.inv.id }, data: { processingSince: now } });
    expect(await runSuspensions(now, s)).toBe(0);
  });

  it("paying resumes the client automatically", async () => {
    const { c, inv } = await failing(31);
    await runSuspensions(now, s);
    await db.invoice.update({ where: { id: inv.id }, data: { status: "paid", paidAt: now } });
    expect(await resumeIfPaidUp(c.id, s)).toBe(true);
    expect(stripe.subscriptions.update).toHaveBeenLastCalledWith(c.stripeSubscriptionId, { pause_collection: "", metadata: { bc_suspended: "" } });
    const after = await db.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.suspendedAt).toBeNull();
    expect(after.status).toBe("CURRENT");
  });

  it("doesn't resume while another failed invoice is still open", async () => {
    const { c } = await failing(31);
    await db.invoice.create({ data: { stripeInvoiceId: "in_other", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: now, periodStart: now, periodEnd: now } });
    await runSuspensions(now, s);
    expect(await resumeIfPaidUp(c.id, s)).toBe(false);
  });

  it("Owners can resume by hand; Admins can't", async () => {
    const { c } = await failing(31);
    await runSuspensions(now, s);
    as("ADMIN");
    expect((await resumeClient(c.id, s)).ok).toBe(false);
    as("OWNER");
    expect(await resumeClient(c.id, s)).toEqual({ ok: true });
    expect((await db.client.findUniqueOrThrow({ where: { id: c.id } })).suspendedAt).toBeNull();
  });

  it("a suspended status ranks ahead of past due", () => {
    const base = { type: "DIRECT" as const, endedAt: null, paused: false, onboardingComplete: true, acePrepaidUntil: null, continuingAwaitingPm: false, now };
    expect(deriveClientStatus({ ...base, suspended: true, latestInvoice: { status: "open", firstFailedAt: new Date(now.getTime() - 40 * DAY) } })).toBe("SUSPENDED");
  });
});

describe("suspension wiring", () => {
  it("a paid monthly invoice triggers the resume check; the live dashboard shows suspended subscriptions", async () => {
    const { handleStripeEvent } = await import("@/stripe/webhook");
    const { event, invoice } = await import("../stripe/fixtures");
    const { mapSubscription } = await import("@/stripe/mapSubscription");
    await db.client.create({ data: { name: "A", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    const onSubscriptionInvoicePaid = vi.fn();
    await handleStripeEvent(event("invoice.paid", invoice({ status: "paid", status_transitions: { paid_at: 1, finalized_at: 1 } })), {
      getPaidMethod: async () => null, getPaymentMethodFunding: async () => null, onInvoiceCreated: async () => {}, onInvoicePaid: async () => {}, onSubscriptionInvoicePaid,
    });
    expect(onSubscriptionInvoicePaid).toHaveBeenCalledTimes(1);
    const sub = { id: "sub_1", status: "active", customer: { id: "cus_1", name: "A" }, metadata: { bc_suspended: "1" }, items: { data: [] }, latest_invoice: null, collection_method: "charge_automatically" } as unknown as Stripe.Subscription;
    expect(mapSubscription(sub, new Map(), now).status).toBe("SUSPENDED");
  });

  it("the daily run suspends", async () => {
    const { runDaily } = await import("@/notify/daily");
    vi.doMock("@/stripe/client", () => ({ getStripe: () => stripe }));
    expect(Object.keys(await runDaily(now))).toContain("suspensions");
  });
});
