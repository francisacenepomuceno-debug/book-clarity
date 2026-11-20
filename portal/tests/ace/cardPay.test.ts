import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { createBatch, setAceCustomer } from "@/ace/batches";
import { aceCardPayLink, onAceCardSetupCompleted, startAceCardCheckout } from "@/ace/cardPay";
import { CARD_FEE_DESCRIPTION } from "@/domain/cardFee";
import { handleStripeEvent } from "@/stripe/webhook";
import { resetDb } from "../helpers/db";
import { event } from "../stripe/fixtures";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "a", email: "a@x.co", name: "A", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

function fakeStripe(funding: "credit" | "debit" = "credit") {
  let n = 0;
  return {
    customers: { retrieve: vi.fn(async (id: string) => ({ id, address: { state: "TX" } })) },
    invoices: {
      create: vi.fn(async () => ({ id: n++ === 0 ? "in_ach" : "in_card" })),
      finalizeInvoice: vi.fn(async (id: string) => ({ id })),
      sendInvoice: vi.fn(async (id: string) => ({ id })),
      retrieve: vi.fn(async (id: string) => ({ id, status: id === "in_ach" ? "open" : "draft" })),
      voidInvoice: vi.fn(async (id: string) => ({ id, status: "void" })),
      pay: vi.fn(async (id: string) => ({ id, status: "paid" })),
    },
    invoiceItems: { create: vi.fn(async () => ({ id: "ii" })) },
    checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_card", url: "https://checkout.stripe.test/cs_card" })) } },
    setupIntents: { retrieve: vi.fn(async () => ({ id: "seti", payment_method: { id: "pm_1", type: "card", card: { funding } } })) },
  };
}
const stripeRef: { current: ReturnType<typeof fakeStripe> } = { current: fakeStripe() };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const s = () => stripeRef.current;

let growth: string;
let batchId: string;
const session = (id = "cs_card") =>
  ({ id, mode: "setup", customer: "cus_ace", setup_intent: "seti", metadata: { kind: "ACE_BATCH_CARD", batchId } }) as unknown as Stripe.Checkout.Session;

beforeEach(async () => {
  await resetDb();
  stripeRef.current = fakeStripe();
  sessionRef.current = OWNER;
  await db.setting.create({ data: { key: "cardFee", value: { enabled: true, rateBasisPoints: 300, excludedStates: [] } } });
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } })).id;
  await setAceCustomer("cus_ace");
  batchId = ((await createBatch({ purchasedOn: "2026-11-01", lines: [{ packageId: growth, quantity: 2, unitPriceCents: 450000 }] })) as { batchId: string }).batchId;
  s().invoices.create.mockClear();
  s().invoiceItems.create.mockClear();
});

describe("card payment link for ACE", () => {
  it("Owners get a portal link; Admins can't", async () => {
    const r = await aceCardPayLink(batchId, "https://portal.test");
    expect(r).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/portal\.test\/pay\/ace\//) });
    sessionRef.current = ADMIN;
    expect((await aceCardPayLink(batchId, "https://portal.test")).ok).toBe(false);
  });

  it("the link opens a fresh Stripe card page; a tampered link or a paid batch is refused", async () => {
    const { url } = (await aceCardPayLink(batchId, "https://portal.test")) as { url: string };
    const token = url.split("/pay/ace/")[1];
    expect(await startAceCardCheckout(token, "https://portal.test")).toEqual({ url: "https://checkout.stripe.test/cs_card" });
    expect((s().checkout.sessions.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      mode: "setup",
      customer: "cus_ace",
      allowed_payment_method_types: ["card"],
      metadata: { kind: "ACE_BATCH_CARD", batchId },
    });
    expect(await startAceCardCheckout(token.slice(0, -2) + "xx", "https://portal.test")).toEqual({ error: expect.any(String) });
    await db.aceBatch.update({ where: { id: batchId }, data: { paidAt: new Date() } });
    expect(await startAceCardCheckout(token, "https://portal.test")).toEqual({ error: expect.stringMatching(/already paid/) });
  });
});

describe("after ACE saves a card", () => {
  it("credit card: voids the ACH invoice, reissues it with the 3% fee line and charges the card", async () => {
    await onAceCardSetupCompleted(session(), s() as unknown as Stripe);
    expect(s().invoices.voidInvoice).toHaveBeenCalledWith("in_ach");
    const items = s().invoiceItems.create.mock.calls.map((c) => (c as unknown[])[0] as { amount: number; description: string; discountable?: boolean });
    expect(items.map((i) => i.amount)).toEqual([900000, 27000]);
    expect(items[1]).toMatchObject({ description: CARD_FEE_DESCRIPTION, discountable: false });
    expect(s().invoices.pay).toHaveBeenCalledWith("in_card", { payment_method: "pm_1" }, { idempotencyKey: "bc-ace-card-pay-cs_card" });
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } })).stripeInvoiceId).toBe("in_card");
  });

  it("debit card: no fee", async () => {
    stripeRef.current = fakeStripe("debit");
    await onAceCardSetupCompleted(session(), s() as unknown as Stripe);
    expect(s().invoiceItems.create.mock.calls.map((c) => ((c as unknown[])[0] as { amount: number }).amount)).toEqual([900000]);
  });

  it("card fee switched off: no fee", async () => {
    await db.setting.update({ where: { key: "cardFee" }, data: { value: { enabled: false, rateBasisPoints: 300, excludedStates: [] } } });
    await onAceCardSetupCompleted(session(), s() as unknown as Stripe);
    expect(s().invoiceItems.create).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a batch that's already paid", async () => {
    await db.aceBatch.update({ where: { id: batchId }, data: { paidAt: new Date() } });
    await onAceCardSetupCompleted(session(), s() as unknown as Stripe);
    expect(s().invoices.create).not.toHaveBeenCalled();
    expect(s().invoices.voidInvoice).not.toHaveBeenCalled();
  });

  it("is routed from checkout.session.completed", async () => {
    const onAceCardSetupCompletedDep = vi.fn(async () => {});
    await handleStripeEvent(event("checkout.session.completed", session()), {
      getPaidMethod: async () => null,
      getPaymentMethodFunding: async () => null,
      onInvoiceCreated: async () => {},
      onInvoicePaid: async () => {},
      onAceCardSetupCompleted: onAceCardSetupCompletedDep,
    });
    expect(onAceCardSetupCompletedDep).toHaveBeenCalledTimes(1);
  });
});
