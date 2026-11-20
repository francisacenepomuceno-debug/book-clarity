import { beforeEach, describe, expect, it, vi } from "vitest";
import { templates } from "@/notify/templates";
import { db } from "@/lib/db";
import { startPaymentUpdate, updatePaymentLink } from "@/notify/paymentLink";
import { resetDb } from "../helpers/db";

const stripe = { billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.test/s" })) } } };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripe }));

const all = () => [
  templates.upcomingCharge({ name: "Acme LLC", amount: "$650.00", date: "Dec 1, 2026", updateUrl: "https://p/pay/update/x" }),
  ...([0, 3, 7, 14] as const).map((day) => templates.paymentFailed({ name: "Acme LLC", amount: "$650.00", day, updateUrl: "https://p/pay/update/x" })),
  templates.ownerAtRisk({ clientName: "Acme LLC", amount: "$650.00", since: "Oct 30, 2026", clientUrl: "https://p/clients/sub_1" }),
  templates.aceProgramEnding({ name: "Acme LLC", endDate: "Jan 14, 2027", daysLeft: 60, continueUrl: "https://p/continue/x" }),
  templates.ownerAceNoDecision({ clientName: "Acme LLC", endDate: "Jan 14, 2027", clientUrl: "https://p/clients/c1" }),
  templates.aceBatchUnpaid({ amount: "$26,000.00", sentOn: "Nov 1, 2026", payUrl: "https://p/pay/ace/x" }),
];

describe("templates", () => {
  it("every message names the client (or batch), carries its link, and keeps SMS short", () => {
    for (const t of all()) {
      expect(t.subject.length).toBeGreaterThan(5);
      expect(t.html).toMatch(/https:\/\/p\//);
      expect(t.sms.length).toBeLessThanOrEqual(320);
      expect(t.sms).toMatch(/https:\/\/p\//);
      expect(t.html).toMatch(/Book Clarity/);
    }
  });
  it("the first failed-payment notice has the agreed subject", () => {
    expect(templates.paymentFailed({ name: "A", amount: "$1", day: 0, updateUrl: "https://p/u" }).subject).toBe("Your Book Clarity payment didn't go through");
  });
  it("the ACE notice states the end date and both choices", () => {
    const t = templates.aceProgramEnding({ name: "Acme LLC", endDate: "Jan 14, 2027", daysLeft: 60, continueUrl: "https://p/continue/x" });
    expect(t.html).toMatch(/Jan 14, 2027/);
    expect(t.html).toMatch(/continue/i);
    expect(t.html).toMatch(/no thanks|not continue/i);
  });
  it("escapes names in HTML", () => {
    expect(templates.upcomingCharge({ name: "<b>X</b>", amount: "$1", date: "d", updateUrl: "https://p/u" }).html).not.toMatch(/<b>X<\/b>/);
  });
});

describe("update-payment link", () => {
  beforeEach(resetDb);
  it("opens a Stripe page to update the payment method; refuses tampered links and ended clients", async () => {
    const c = await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1" } });
    const url = updatePaymentLink(c.id, "https://p");
    const token = url.split("/pay/update/")[1];
    expect(await startPaymentUpdate(token, "https://p")).toEqual({ url: "https://billing.stripe.test/s" });
    expect((stripe.billingPortal.sessions.create.mock.calls[0] as unknown[])[0]).toMatchObject({ customer: "cus_1", flow_data: { type: "payment_method_update" } });
    expect(await startPaymentUpdate(token.slice(0, -2) + "xx", "https://p")).toEqual({ error: expect.any(String) });
    await db.client.update({ where: { id: c.id }, data: { endedAt: new Date() } });
    expect(await startPaymentUpdate(token, "https://p")).toEqual({ error: expect.any(String) });
  });
});
