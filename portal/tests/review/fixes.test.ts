import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator } from "otplib";
import { db } from "@/lib/db";
import { handleStripeEvent, type WebhookDeps } from "@/stripe/webhook";
import { syncClientsFromSnapshot } from "@/clients/queries";
import { hashPassword } from "@/auth/password";
import { resetDb } from "../helpers/db";
import { event, invoice, ts } from "../stripe/fixtures";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({
  getCurrentSession: async () => sessionRef.current,
  setSessionCookie: async () => {},
  clearSessionCookie: async () => {},
}));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

const deps = (): WebhookDeps => ({
  getPaidMethod: vi.fn(async () => null),
  getPaymentMethodFunding: vi.fn(async () => "credit"),
  onInvoiceCreated: vi.fn(async () => {}),
  onInvoicePaid: vi.fn(async () => {}),
});

let clientId: string;
beforeEach(async () => {
  await resetDb();
  clientId = (await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "CURRENT" } })).id;
});

describe("I2: out-of-order invoice events never move an invoice backwards", () => {
  it("a late invoice.created after invoice.paid keeps the invoice paid and the client Current", async () => {
    const paid = invoice({ status: "paid", amount_paid: 80000, amount_remaining: 0, status_transitions: { paid_at: ts("2026-12-02") } });
    await handleStripeEvent(event("invoice.paid", paid), deps());
    await handleStripeEvent(event("invoice.created", invoice({ status: "draft" })), deps());
    await handleStripeEvent(event("invoice.finalized", invoice({ status: "open" })), deps());
    const row = await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_1" } });
    expect(row.status).toBe("paid");
    expect(row.amountPaidCents).toBe(80000);
    expect(row.paidAt).not.toBeNull();
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).status).toBe("CURRENT");
  });
});

describe("I3: an event stuck half-processed is retried, not reported as duplicate", () => {
  it("re-processes when the earlier attempt never finished (stale claim)", async () => {
    await db.stripeEvent.create({ data: { id: "evt_stuck", type: "invoice.created", receivedAt: new Date(Date.now() - 10 * 60_000) } });
    const d = deps();
    expect(await handleStripeEvent(event("invoice.created", invoice({ status: "draft" }), "evt_stuck"), d)).toBe("processed");
    expect(d.onInvoiceCreated).toHaveBeenCalledTimes(1);
  });
  it("still reports duplicate while another attempt is in flight (fresh claim)", async () => {
    await db.stripeEvent.create({ data: { id: "evt_busy", type: "invoice.created" } });
    expect(await handleStripeEvent(event("invoice.created", invoice({ status: "draft" }), "evt_busy"), deps())).toBe("duplicate");
  });
});

describe("I8: page-load sync never overwrites webhook-owned fields", () => {
  it("only creates missing clients; existing status, subscription link and Stripe status are kept", async () => {
    await db.client.update({ where: { id: clientId }, data: { status: "PAST_DUE", subscriptionStatus: "past_due" } });
    await syncClientsFromSnapshot([
      {
        customerId: "cus_1", subscriptionId: "sub_other", name: "Acme", email: null, status: "CURRENT", packageName: "Growth",
        sixMonthContract: false, packageMonthlyCents: 1, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true,
        paymentMethod: "ACH", nextChargeDate: null, amountDueCents: 0, pastDueSince: null,
      },
    ]);
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(c).toMatchObject({ status: "PAST_DUE", subscriptionStatus: "past_due", stripeSubscriptionId: "sub_1" });
  });
});

describe("I6: sign-in throttling and TOTP replay", () => {
  it("locks password sign-in after 5 failures in 15 minutes, even with the right password", async () => {
    const { loginAction } = await import("@/auth/actions");
    await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER", passwordHash: await hashPassword("right-password-123") } });
    const form = (pw: string) => { const f = new FormData(); f.set("email", "jose@bc.test"); f.set("password", pw); return f; };
    for (let i = 0; i < 5; i++) expect((await loginAction({}, form("nope"))).error).toBe("Email or password is incorrect.");
    expect((await loginAction({}, form("right-password-123"))).error).toMatch(/Too many attempts/);
  });

  it("rejects reusing a TOTP code that was already accepted", async () => {
    const { verifyTotpAction } = await import("@/auth/actions");
    const secret = authenticator.generateSecret();
    const u = await db.user.create({ data: { email: "o@bc.test", name: "O", role: "OWNER", totpSecret: secret, totpEnabled: true } });
    sessionRef.current = { user: { ...u }, twoFactorVerified: false };
    const code = authenticator.generate(secret);
    const f = () => { const x = new FormData(); x.set("code", code); return x; };
    await expect(verifyTotpAction({}, f())).rejects.toThrow("REDIRECT:/");
    expect((await verifyTotpAction({}, f())).error).toMatch(/already used/);
  });

  it("locks 2FA after 5 wrong codes", async () => {
    const { verifyTotpAction } = await import("@/auth/actions");
    const secret = authenticator.generateSecret();
    const u = await db.user.create({ data: { email: "o2@bc.test", name: "O", role: "OWNER", totpSecret: secret, totpEnabled: true } });
    sessionRef.current = { user: { ...u }, twoFactorVerified: false };
    const f = (c: string) => { const x = new FormData(); x.set("code", c); return x; };
    for (let i = 0; i < 5; i++) await verifyTotpAction({}, f("000000"));
    expect((await verifyTotpAction({}, f(authenticator.generate(secret)))).error).toMatch(/Too many attempts/);
  });
});

describe("I7: an authenticator can't be set up with just a password", () => {
  it("no secret is generated for a user without one; they are told to ask the Super Admin", async () => {
    const { verifyTotpAction, startTotpEnrolment } = await import("@/auth/actions" as string) as Record<string, unknown> & typeof import("@/auth/actions");
    expect(startTotpEnrolment).toBeUndefined();
    const u = await db.user.create({ data: { email: "new@bc.test", name: "New", role: "OWNER" } });
    sessionRef.current = { user: { ...u }, twoFactorVerified: false };
    const f = new FormData(); f.set("code", "123456");
    expect((await verifyTotpAction({}, f)).error).toMatch(/Super Admin/);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).totpSecret).toBeNull();
  });
});
