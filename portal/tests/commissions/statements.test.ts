import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { recordPaymentCommission, recordRefundClawback } from "@/commissions/engine";
import { commissionProgress, listStatements, markStatementPaid, statementLines } from "@/commissions/statements";
import { monthOf } from "@/domain/commission";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "owner1", email: "o@x.co", name: "Owner", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "admin1", email: "a@x.co", name: "Alex", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

let clientId: string;
let jose: string;
let n = 0;
async function pay(paidAt: string) {
  n += 1;
  const inv = await db.invoice.create({
    data: {
      stripeInvoiceId: `in_${n}`, clientId, status: "paid", kind: "SUBSCRIPTION",
      subtotalCents: 80000, totalCents: 80000, amountPaidCents: 80000, paidAt: new Date(paidAt),
      periodStart: new Date(paidAt), periodEnd: new Date(paidAt),
    },
  });
  await recordPaymentCommission(inv.id);
  return inv;
}

beforeEach(async () => {
  await resetDb();
  n = 0;
  sessionRef.current = OWNER;
  clientId = (await db.client.create({ data: { name: "Acme LLC", stripeCustomerId: "cus_1", status: "CURRENT" } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  await db.commissionShare.create({ data: { clientId, executiveId: jose, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u" } });
});

describe("statements", () => {
  it("one row per executive and month, newest first", async () => {
    await pay("2026-10-05T15:00:00Z");
    await pay("2026-10-20T15:00:00Z");
    await pay("2026-11-05T15:00:00Z");
    const rows = await listStatements();
    expect(rows.map((r) => [r.executiveName, r.month, r.totalCents, r.status, r.lineCount])).toEqual([
      ["Jose", "2026-11", 8000, "OPEN", 1],
      ["Jose", "2026-10", 16000, "OPEN", 2],
    ]);
    const lines = await statementLines(jose, "2026-10");
    expect(lines.map((l) => [l.clientName, l.kind, l.amountCents, l.windowIndex])).toEqual([
      ["Acme LLC", "EARNED", 8000, 1],
      ["Acme LLC", "EARNED", 8000, 2],
    ]);
  });

  it("a paid month is locked: a later refund lands in the next open month", async () => {
    const oct = await pay("2026-10-05T15:00:00Z");
    await pay("2026-10-20T15:00:00Z");
    expect(await markStatementPaid(jose, "2026-10", new Date("2026-11-02T15:00:00Z"))).toEqual({ ok: true });
    await recordRefundClawback(oct.id, { refundKey: "re_1", packageCents: 40000, at: new Date("2026-10-25T15:00:00Z") });

    const rows = await listStatements();
    const october = rows.find((r) => r.month === "2026-10")!;
    expect(october).toMatchObject({ status: "PAID", totalCents: 16000, lineCount: 2 });
    expect(rows.find((r) => r.month === "2026-11")).toMatchObject({ status: "OPEN", totalCents: -4000 });
    expect(await db.auditLog.count({ where: { action: "commission_statement_paid" } })).toBe(1);
  });

  it("refuses paying the current month, paying twice, an empty month, or an Admin", async () => {
    await pay("2026-10-05T15:00:00Z");
    const current = monthOf(new Date(), "America/New_York");
    expect((await markStatementPaid(jose, current, new Date())).ok).toBe(false);
    expect((await markStatementPaid(jose, "2026-10", new Date())).ok).toBe(true);
    expect((await markStatementPaid(jose, "2026-10", new Date())).ok).toBe(false);
    expect((await markStatementPaid(jose, "2026-03", new Date())).ok).toBe(false);
    sessionRef.current = ADMIN;
    await pay("2026-09-05T15:00:00Z");
    expect(await markStatementPaid(jose, "2026-09", new Date())).toEqual({ ok: false, error: "You don't have permission to do that." });
  });

  it("Admins can't read statements", async () => {
    sessionRef.current = ADMIN;
    await expect(listStatements()).rejects.toThrow(/Forbidden/);
  });
});

describe("commissionProgress", () => {
  it("counts months earned before and inside the portal", async () => {
    await db.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: 3 } });
    await pay("2026-10-05T15:00:00Z");
    await pay("2026-11-05T15:00:00Z");
    expect(await commissionProgress(clientId)).toEqual({
      windowMonths: 12,
      earnedMonths: 5,
      remainingMonths: 7,
      split: [{ executiveName: "Jose", ratePercent: 10 }],
    });
  });
});
