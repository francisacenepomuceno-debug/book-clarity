import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { handleStripeEvent, type WebhookDeps } from "@/stripe/webhook";
import { resetDb } from "../helpers/db";
import { event, invoice } from "./fixtures";

const deps = (): WebhookDeps => ({
  getPaidMethod: vi.fn(async () => ({ type: "card" as const, funding: "credit" as const, chargeId: "ch_1" })),
  getPaymentMethodFunding: vi.fn(async () => "credit"),
  onInvoiceCreated: vi.fn(async () => {}),
  onInvoicePaid: vi.fn(async () => {}),
});

beforeEach(async () => {
  await resetDb();
  await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
});

describe("handleStripeEvent", () => {
  it("processes once, then reports duplicate without re-running side effects", async () => {
    const d = deps();
    const e = event("invoice.created", invoice({ status: "draft" }), "evt_dup");
    expect(await handleStripeEvent(e, d)).toBe("processed");
    expect(await handleStripeEvent(e, d)).toBe("duplicate");
    expect(d.onInvoiceCreated).toHaveBeenCalledTimes(1);
  });

  it("stores and ignores unknown event types", async () => {
    expect(await handleStripeEvent(event("charge.dispute.created", {}, "evt_unk"), deps())).toBe("ignored");
    expect(await db.stripeEvent.findUnique({ where: { id: "evt_unk" } })).not.toBeNull();
  });

  it("forgets the event when a handler throws, so Stripe's retry is processed", async () => {
    const d = deps();
    d.onInvoiceCreated = vi.fn(async () => {
      throw new Error("boom");
    });
    const e = event("invoice.created", invoice({ status: "draft" }), "evt_fail");
    await expect(handleStripeEvent(e, d)).rejects.toThrow("boom");
    expect(await db.stripeEvent.findUnique({ where: { id: "evt_fail" } })).toBeNull();
  });
});

describe("POST /api/stripe/webhook", () => {
  it("rejects a bad signature with 400", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(new Request("http://x/api/stripe/webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=bad" } }));
    expect(res.status).toBe(400);
  });

  it("accepts a correctly signed event", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const payload = JSON.stringify({ id: "evt_signed", type: "ping.test", object: "event", data: { object: {} } });
    const header = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    const res = await POST(new Request("http://x/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "ignored" });
  });
});
