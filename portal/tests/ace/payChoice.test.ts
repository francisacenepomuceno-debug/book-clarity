import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createBatch, setAceCustomer } from "@/ace/batches";
import { aceCardPayLink, acePayOptions, startAceBankPayment } from "@/ace/cardPay";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };

const invoices = new Map<string, { id: string; status: string; hosted_invoice_url: string; metadata: Record<string, string> }>();
let created = 0;
function fakeStripe() {
  return {
    customers: { retrieve: vi.fn(async (id: string) => ({ id })) },
    invoices: {
      create: vi.fn(async () => {
        const id = `in_${++created}`;
        invoices.set(id, { id, status: "draft", hosted_invoice_url: `https://invoice.stripe.test/${id}`, metadata: {} });
        return { id };
      }),
      finalizeInvoice: vi.fn(async (id: string) => { invoices.get(id)!.status = "open"; return { id }; }),
      sendInvoice: vi.fn(async (id: string) => ({ id })),
      retrieve: vi.fn(async (id: string) => invoices.get(id)),
      voidInvoice: vi.fn(async (id: string) => { invoices.get(id)!.status = "void"; return { id }; }),
    },
    invoiceItems: { create: vi.fn(async () => ({ id: "ii" })) },
  };
}
const stripeRef: { current: ReturnType<typeof fakeStripe> } = { current: fakeStripe() };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const s = () => stripeRef.current;

let batchId: string;
let token: string;
beforeEach(async () => {
  await resetDb();
  invoices.clear();
  created = 0;
  stripeRef.current = fakeStripe();
  sessionRef.current = OWNER;
  const growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } })).id;
  await setAceCustomer("cus_ace");
  batchId = ((await createBatch({ purchasedOn: "2026-11-01", lines: [{ packageId: growth, quantity: 2, unitPriceCents: 450000 }] })) as { batchId: string }).batchId;
  token = ((await aceCardPayLink(batchId, "https://portal.test")) as { url: string }).url.split("/pay/ace/")[1];
});

describe("ACE chooses how to pay", () => {
  it("shows the total, and the 3% credit-card fee only when the card fee is on", async () => {
    expect(await acePayOptions(token)).toEqual({ batchId, totalCents: 900000, creditCardFeeCents: 0 });
    await db.setting.create({ data: { key: "cardFee", value: { enabled: true, rateBasisPoints: 300, excludedStates: [] } } });
    expect(await acePayOptions(token)).toEqual({ batchId, totalCents: 900000, creditCardFeeCents: 27000 });
  });

  it("refuses a tampered link or a paid batch", async () => {
    expect(await acePayOptions(token.slice(0, -2) + "xx")).toEqual({ error: expect.any(String) });
    await db.aceBatch.update({ where: { id: batchId }, data: { paidAt: new Date() } });
    expect(await acePayOptions(token)).toEqual({ error: expect.stringMatching(/already paid/) });
  });

  it("bank (ACH) goes to the open ACH invoice", async () => {
    expect(await startAceBankPayment(token)).toEqual({ url: "https://invoice.stripe.test/in_1" });
    expect(s().invoices.create).toHaveBeenCalledTimes(1);
  });

  it("bank after a declined card: the card invoice is voided and a fresh ACH invoice is issued", async () => {
    invoices.get("in_1")!.status = "void";
    invoices.set("in_card", { id: "in_card", status: "open", hosted_invoice_url: "https://invoice.stripe.test/in_card", metadata: { payBy: "card" } });
    await db.aceBatch.update({ where: { id: batchId }, data: { stripeInvoiceId: "in_card" } });
    const r = await startAceBankPayment(token);
    expect(s().invoices.voidInvoice).toHaveBeenCalledWith("in_card");
    expect(r).toEqual({ url: "https://invoice.stripe.test/in_2" });
    const keys = s().invoices.create.mock.calls.map((c) => ((c as unknown[])[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([`bc-ace-batch-${batchId}`, `bc-ace-batch-${batchId}-v1`]);
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } })).stripeInvoiceId).toBe("in_2");
  });
});
