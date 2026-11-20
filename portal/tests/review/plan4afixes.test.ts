import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sendNotice } from "@/notify/send";
import { remindable, runPaymentReminders, onPaymentFailedNotice } from "@/notify/payments";
import { runAceNotices } from "@/notify/ace";
import { runDaily } from "@/notify/daily";
import { answerContinuation, continuationToken, markContinuing } from "@/ace/continuation";
import { syncClientsFromSnapshot } from "@/clients/queries";
import { templates } from "@/notify/templates";
import { handleStripeEvent } from "@/stripe/webhook";
import { startPaymentUpdate, updatePaymentLink } from "@/notify/paymentLink";
import { resetDb } from "../helpers/db";
import { event } from "../stripe/fixtures";

const ghl = vi.hoisted(() => ({ configured: true, upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => ghl.configured, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const stripe = {
  customers: { create: vi.fn(async () => ({ id: `cus_${Math.random().toString(36).slice(2)}` })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs", url: "https://checkout.stripe.test/cs" })), expire: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.test/s" })) } },
};
vi.mock("@/stripe/client", () => ({ getStripe: () => stripe }));

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
const notes = () => db.notification.findMany({ orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  await resetDb();
  ghl.configured = true;
  ghl.upsert.mockReset().mockResolvedValue("ct_1");
  ghl.send.mockReset().mockResolvedValue("msg");
  process.env.PORTAL_BASE_URL = "https://portal.test";
  sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
});
afterEach(() => vi.unstubAllEnvs());

describe("#1 production without PORTAL_BASE_URL never sends localhost links", () => {
  it("skips with a clear reason", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.PORTAL_BASE_URL;
    expect(await sendNotice({ key: "k", kind: "t", to: { name: "A", email: "a@x.co" }, email: { subject: "s", html: "h" } })).toBe("SKIPPED");
    expect((await notes())[0].error).toMatch(/PORTAL_BASE_URL/);
    expect(ghl.send).not.toHaveBeenCalled();
  });
});

describe("#2 a failed SMS doesn't resend the email", () => {
  it("counts as sent when email went out, keeping the SMS error", async () => {
    ghl.send.mockImplementation(async (m: { type: string }) => { if (m.type === "SMS") throw new Error("no SMS number"); return "msg"; });
    const n = { key: "k2", kind: "t", to: { name: "A", email: "a@x.co", phone: "+1555" }, email: { subject: "s", html: "h" }, sms: "x" };
    expect(await sendNotice(n)).toBe("SENT");
    expect(await sendNotice(n)).toBe("DUPLICATE");
    expect(ghl.send.mock.calls.filter((c) => (c[0] as { type: string }).type === "Email")).toHaveLength(1);
    expect((await notes())[0]).toMatchObject({ status: "SENT", channels: "email" });
    expect((await notes())[0].error).toMatch(/sms: no SMS number/);
  });
});

describe("#3 the day-0 notice is retried by the daily run", () => {
  it("a day-0 notice that failed is sent again on day 1", async () => {
    const c = await db.client.create({ data: { name: "Acme", email: "a@x.co", stripeSubscriptionId: "sub_1" } });
    const inv = await db.invoice.create({ data: { stripeInvoiceId: "in_1", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(now.getTime() - DAY), periodStart: now, periodEnd: now } });
    ghl.send.mockRejectedValueOnce(new Error("GHL 500"));
    await onPaymentFailedNotice(inv.id, now);
    expect((await notes())[0].status).toBe("FAILED");
    await runPaymentReminders(now);
    expect((await notes())[0].status).toBe("SENT");
  });
});

describe("#4 continuing but no payment method (D6)", () => {
  async function ace(daysLeft: number) {
    const pkg = await db.package.create({ data: { name: `G${Math.random()}`, monthlyPriceCents: 65000, onboardingFeeCents: 0, stripePriceId: `p${Math.random()}` } });
    const c = await db.client.create({ data: { name: "Ace Co", email: "a@x.co", type: "ACE", acePrepaidUntil: new Date(now.getTime() + daysLeft * DAY), packageId: pkg.id } });
    const b = await db.aceBatch.create({ data: { purchasedAt: now, totalCents: 1, createdById: "u", paidAt: now } });
    const s = await db.aceSlot.create({ data: { batchId: b.id, packageId: pkg.id, clientId: c.id } });
    await db.client.update({ where: { id: c.id }, data: { aceSlotId: s.id } });
    return c.id;
  }
  it("reminds the client to finish setup from 14 days out, and alerts Owners after the end", async () => {
    await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER" } });
    const id = await ace(10);
    await db.client.update({ where: { id }, data: { continuationDecision: "CONTINUING", continuationBy: "CLIENT" } });
    await runAceNotices(now);
    expect((await notes()).map((n) => n.key)).toEqual([`ace-setup:${id}:14`]);
    await runAceNotices(new Date(now.getTime() + 12 * DAY));
    expect((await notes()).map((n) => n.key).some((k) => k.startsWith(`ace-awaiting-pm:${id}:`))).toBe(true);
  });
  it("a client's own No clears a Yes they gave earlier (but not an Owner's decision)", async () => {
    const id = await ace(20);
    await answerContinuation(continuationToken(id), "YES", "https://portal.test", now);
    await answerContinuation(continuationToken(id), "NO", "https://portal.test", now);
    expect((await db.client.findUniqueOrThrow({ where: { id } })).continuationDecision).toBeNull();
    const id2 = await ace(20);
    await markContinuing(id2, "https://portal.test");
    await answerContinuation(continuationToken(id2), "NO", "https://portal.test", now);
    expect((await db.client.findUniqueOrThrow({ where: { id: id2 } })).continuationDecision).toBe("CONTINUING");
  });
});

describe("#5 phone numbers and stale GHL contacts", () => {
  it("syncs the phone from Stripe and forgets the cached GHL contact when contact details change", async () => {
    const row = { customerId: "cus_1", subscriptionId: "sub_1", name: "Acme", email: "a@x.co", phone: "+15551112222", status: "CURRENT", packageName: "G", sixMonthContract: false, packageMonthlyCents: 1, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true, paymentMethod: "ACH", nextChargeDate: null, amountDueCents: 0, pastDueSince: null } as const;
    await syncClientsFromSnapshot([row as never]);
    await db.client.update({ where: { stripeCustomerId: "cus_1" }, data: { ghlContactId: "ct_old" } });
    await syncClientsFromSnapshot([{ ...row, email: "new@x.co" } as never]);
    expect(await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_1" } })).toMatchObject({ phone: "+15551112222", email: "new@x.co", ghlContactId: null });
  });
});

describe("#6 placeholder names don't overwrite GHL contacts or appear in greetings", () => {
  it("omits a placeholder name and greets neutrally", async () => {
    await sendNotice({ key: "k6", kind: "t", to: { name: "(no name)", email: "a@x.co" }, email: { subject: "s", html: "h" } });
    expect(ghl.upsert.mock.calls[0][0]).not.toHaveProperty("name");
    expect(templates.upcomingCharge({ name: "jane@x.com", amount: "$1", date: "d", updateUrl: "https://p/u" }).html).toMatch(/Hi there,/);
  });
});

describe("#7 a notice stuck mid-send is reported", () => {
  it("runDaily counts PENDING notices older than an hour", async () => {
    await db.notification.create({ data: { key: "stuck", kind: "t", status: "PENDING", createdAt: new Date(now.getTime() - 2 * 3600_000) } });
    expect((await runDaily(now)).stuckNotices).toBe(1);
  });
});

describe("#8 ACE clients without a prepaid date are never reminded", () => {
  it("is not remindable", () => {
    expect(remindable({ type: "ACE", endedAt: null, acePrepaidUntil: null }, now)).toBe(false);
    expect(remindable({ type: "DIRECT", endedAt: null, acePrepaidUntil: null }, now)).toBe(true);
  });
});

describe("#9 no 'decision needed' alert for clients who already ended", () => {
  it("skips ended ACE clients", async () => {
    await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER" } });
    const pkg = await db.package.create({ data: { name: "G", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    const c = await db.client.create({ data: { name: "Old", type: "ACE", acePrepaidUntil: new Date(now.getTime() - 90 * DAY), endedAt: new Date(now.getTime() - 90 * DAY), packageId: pkg.id } });
    const b = await db.aceBatch.create({ data: { purchasedAt: now, totalCents: 1, createdById: "u", paidAt: now } });
    const s = await db.aceSlot.create({ data: { batchId: b.id, packageId: pkg.id, clientId: c.id } });
    await db.client.update({ where: { id: c.id }, data: { aceSlotId: s.id } });
    await runAceNotices(now);
    expect(await notes()).toHaveLength(0);
  });
});

describe("#10 no 'still outstanding' reminder while an ACH payment is processing", () => {
  it("records processing from Stripe and skips the reminder", async () => {
    const c = await db.client.create({ data: { name: "Acme", email: "a@x.co", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    const inv = await db.invoice.create({ data: { stripeInvoiceId: "in_1", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(now.getTime() - 3 * DAY), periodStart: now, periodEnd: now } });
    await handleStripeEvent(event("payment_intent.processing", { id: "pi_1", object: "payment_intent" }), {
      getPaidMethod: async () => null, getPaymentMethodFunding: async () => null, onInvoiceCreated: async () => {}, onInvoicePaid: async () => {},
      getInvoiceIdForPaymentIntent: async () => "in_1",
    });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).processingSince).not.toBeNull();
    await runPaymentReminders(now);
    expect(await notes()).toHaveLength(0);
  });
});

describe("#11 the update-payment page returns to the portal, not the full billing portal", () => {
  it("sets after_completion redirect", async () => {
    const c = await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1" } });
    await startPaymentUpdate(updatePaymentLink(c.id, "https://p").split("/pay/update/")[1], "https://p");
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      flow_data: { type: "payment_method_update", after_completion: { type: "redirect", redirect: { return_url: "https://p/setup-complete?updated=1" } } },
    });
  });
});
