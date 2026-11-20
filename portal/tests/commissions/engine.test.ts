import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordPaymentCommission, recordRefundClawback, recomputeClient } from "@/commissions/engine";
import { resetDb } from "../helpers/db";

let clientId: string;
let jose: string;
let n = 0;

async function paidInvoice(paidAt: string, amountPaidCents = 82400, cardFeeCents = 2400) {
  n += 1;
  return db.invoice.create({
    data: {
      stripeInvoiceId: `in_${n}`,
      clientId,
      status: "paid",
      kind: "SUBSCRIPTION",
      subtotalCents: amountPaidCents - cardFeeCents,
      totalCents: amountPaidCents,
      cardFeeCents,
      amountPaidCents,
      paidAt: new Date(paidAt),
      periodStart: new Date(paidAt),
      periodEnd: new Date(paidAt),
    },
  });
}

const entries = () => db.commissionEntry.findMany({ orderBy: [{ occurredAt: "asc" }, { kind: "asc" }] });

beforeEach(async () => {
  await resetDb();
  n = 0;
  clientId = (await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", status: "CURRENT" } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  await db.commissionShare.create({ data: { clientId, executiveId: jose, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u" } });
});

describe("recordPaymentCommission", () => {
  it("earns 10% of the package amount (card fee excluded) in the month paid", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    expect(await recordPaymentCommission(inv.id)).toBe(1);
    const [e] = await entries();
    expect(e).toMatchObject({ kind: "EARNED", executiveId: jose, baseCents: 80000, rateBp: 1000, amountCents: 8000, month: "2026-11", windowIndex: 1 });
  });

  it("is idempotent", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    await recordPaymentCommission(inv.id);
    expect(await recordPaymentCommission(inv.id)).toBe(0);
    expect(await db.commissionEntry.count()).toBe(1);
  });

  it("stops after the 12th paid month, counting months earned before the portal", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 11 } });
    const a = await paidInvoice("2026-10-15T15:00:00Z");
    const b = await paidInvoice("2026-11-15T15:00:00Z");
    expect(await recordPaymentCommission(a.id)).toBe(1);
    expect(await recordPaymentCommission(b.id)).toBe(0);
    expect((await entries())[0].windowIndex).toBe(12);
  });

  it("a $0 (100% off) month earns nothing and doesn't use up the window", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 10 } });
    const i1 = await paidInvoice("2026-08-15T15:00:00Z");
    const free = await paidInvoice("2026-09-15T15:00:00Z", 0, 0);
    const i3 = await paidInvoice("2026-10-15T15:00:00Z");
    const i4 = await paidInvoice("2026-11-15T15:00:00Z");
    for (const i of [i1, free, i3, i4]) await recordPaymentCommission(i.id);
    expect((await entries()).map((e) => e.windowIndex)).toEqual([11, 12]);
  });

  it("does nothing for a client without a commission owner", async () => {
    await db.commissionShare.deleteMany();
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    expect(await recordPaymentCommission(inv.id)).toBe(0);
  });

  it("ignores unpaid and non-subscription invoices", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    await db.invoice.update({ where: { id: inv.id }, data: { kind: "ONBOARDING" } });
    expect(await recordPaymentCommission(inv.id)).toBe(0);
    await db.invoice.update({ where: { id: inv.id }, data: { kind: "SUBSCRIPTION", status: "open" } });
    expect(await recordPaymentCommission(inv.id)).toBe(0);
  });

  it("posts to the next open month when the payment's month is already paid out", async () => {
    await db.commissionStatement.create({ data: { executiveId: jose, month: "2026-11", status: "PAID", paidAt: new Date(), totalCents: 0 } });
    const inv = await paidInvoice("2026-11-20T15:00:00Z");
    await recordPaymentCommission(inv.id);
    expect((await entries())[0].month).toBe("2026-12");
  });
});

describe("recordRefundClawback", () => {
  it("claws back proportionally, once per refund", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    await recordPaymentCommission(inv.id);
    expect(await recordRefundClawback(inv.id, { refundKey: "re_1", packageCents: 40000, at: new Date("2026-12-03T15:00:00Z") })).toBe(1);
    expect(await recordRefundClawback(inv.id, { refundKey: "re_1", packageCents: 40000, at: new Date("2026-12-03T15:00:00Z") })).toBe(0);
    const claw = (await entries()).find((e) => e.kind === "CLAWBACK")!;
    expect(claw).toMatchObject({ amountCents: -4000, month: "2026-12", refundKey: "re_1", executiveId: jose });
  });

  it("never claws back more than was earned across refunds", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    await recordPaymentCommission(inv.id);
    await recordRefundClawback(inv.id, { refundKey: "re_1", packageCents: 60000, at: new Date("2026-12-03") });
    await recordRefundClawback(inv.id, { refundKey: "re_2", packageCents: 60000, at: new Date("2026-12-04") });
    const total = (await entries()).filter((e) => e.kind === "CLAWBACK").reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(-8000);
  });

  it("no commission, nothing to claw back", async () => {
    const inv = await paidInvoice("2026-11-15T15:00:00Z");
    expect(await recordRefundClawback(inv.id, { refundKey: "re_1", packageCents: 40000, at: new Date() })).toBe(0);
  });
});

describe("recomputeClient", () => {
  it("records every paid invoice once, oldest first", async () => {
    await paidInvoice("2026-10-15T15:00:00Z");
    await paidInvoice("2026-11-15T15:00:00Z");
    expect(await recomputeClient(clientId)).toBe(2);
    expect(await recomputeClient(clientId)).toBe(0);
    expect((await entries()).map((e) => e.windowIndex)).toEqual([1, 2]);
  });
});
