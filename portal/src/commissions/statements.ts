import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { monthOf, packagePaidCents, splitAt, windowMonthsFor } from "@/domain/commission";
import type { ActionResult } from "@/billing/discounts";
import { lockExecutive } from "@/commissions/engine";

const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";

export type StatementRow = {
  executiveId: string;
  executiveName: string;
  month: string;
  totalCents: number;
  lineCount: number;
  status: "OPEN" | "PAID";
  paidAt: Date | null;
};

/** One row per executive and month with ledger lines, newest month first. Paid rows show their frozen total. */
export async function listStatements(): Promise<StatementRow[]> {
  await requirePermission("commissions.view");
  const [groups, statements, executives] = await Promise.all([
    db.commissionEntry.groupBy({ by: ["executiveId", "month"], _sum: { amountCents: true }, _count: { _all: true } }),
    db.commissionStatement.findMany(),
    db.executive.findMany(),
  ]);
  const names = new Map(executives.map((e) => [e.id, e.name]));
  const paid = new Map(statements.filter((s) => s.status === "PAID").map((s) => [`${s.executiveId}|${s.month}`, s]));
  return groups
    .map((g) => {
      const s = paid.get(`${g.executiveId}|${g.month}`);
      return {
        executiveId: g.executiveId,
        executiveName: names.get(g.executiveId) ?? "(removed)",
        month: g.month,
        totalCents: s ? s.totalCents ?? 0 : g._sum.amountCents ?? 0,
        lineCount: g._count._all,
        status: s ? ("PAID" as const) : ("OPEN" as const),
        paidAt: s?.paidAt ?? null,
      };
    })
    .sort((a, b) => b.month.localeCompare(a.month) || a.executiveName.localeCompare(b.executiveName));
}

export async function statementLines(executiveId: string, month: string) {
  await requirePermission("commissions.view");
  const entries = await db.commissionEntry.findMany({ where: { executiveId, month }, orderBy: [{ occurredAt: "asc" }, { kind: "asc" }] });
  const clients = await db.client.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.clientId))] } }, select: { id: true, name: true, type: true } });
  const invoices = await db.invoice.findMany({ where: { id: { in: entries.map((e) => e.invoiceId) } }, select: { id: true, stripeInvoiceId: true } });
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const clientType = new Map(clients.map((c) => [c.id, c.type]));
  const stripeId = new Map(invoices.map((i) => [i.id, i.stripeInvoiceId]));
  return entries.map((e) => ({
    clientName: clientName.get(e.clientId) ?? "(unknown client)",
    invoiceId: stripeId.get(e.invoiceId) ?? e.invoiceId,
    kind: e.kind,
    occurredAt: e.occurredAt,
    baseCents: e.baseCents,
    rateBp: e.rateBp,
    amountCents: e.amountCents,
    windowIndex: e.windowIndex,
    windowMonths: windowMonthsFor({ type: clientType.get(e.clientId) ?? "DIRECT" }),
  }));
}

/** Marks a past month paid for one executive and freezes its total. Later lines go to the next open month. */
export async function markStatementPaid(executiveId: string, month: string, paidAt: Date): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("commissions.markPaid");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  if (!/^\d{4}-\d{2}$/.test(month) || month >= monthOf(new Date(), tz())) {
    return { ok: false, error: "Only months that have ended can be marked paid." };
  }
  if (Number.isNaN(paidAt.getTime())) return { ok: false, error: "Pick the date it was paid." };

  return db.$transaction(async (tx) => {
    await lockExecutive(tx, executiveId); // no new lines can post into this month while we freeze it
    const existing = await tx.commissionStatement.findUnique({ where: { executiveId_month: { executiveId, month } } });
    if (existing?.status === "PAID") return { ok: false as const, error: "That month is already marked paid." };
    const sum = await tx.commissionEntry.aggregate({ where: { executiveId, month }, _sum: { amountCents: true }, _count: { _all: true } });
    if (sum._count._all === 0) return { ok: false as const, error: "There's nothing on that statement." };
    const totalCents = sum._sum.amountCents ?? 0;
    await tx.commissionStatement.upsert({
      where: { executiveId_month: { executiveId, month } },
      create: { executiveId, month, status: "PAID", paidAt, paidById: actor.id, totalCents },
      update: { status: "PAID", paidAt, paidById: actor.id, totalCents },
    });
    await tx.auditLog.create({
      data: { actorId: actor.id, action: "commission_statement_paid", entity: "CommissionStatement", entityId: `${executiveId}:${month}`, after: { totalCents, paidAt } },
    });
    return { ok: true as const };
  });
}

/** How far a client is through their commission window, and who earns on them now. */
export async function commissionProgress(clientId: string) {
  await requirePermission("commissions.view");
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const windowMonths = windowMonthsFor(client);
  const paid = await db.invoice.findMany({ where: { clientId, kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null } } });
  const earnedMonths = Math.min(windowMonths, client.commissionMonthsBeforePortal + paid.filter((p) => packagePaidCents(p) > 0).length);
  const shares = await db.commissionShare.findMany({ where: { clientId } });
  const execs = await db.executive.findMany({ where: { id: { in: shares.map((s) => s.executiveId) } } });
  const name = new Map(execs.map((e) => [e.id, e.name]));
  return {
    windowMonths,
    earnedMonths,
    remainingMonths: windowMonths - earnedMonths,
    split: splitAt(shares, new Date()).map((s) => ({ executiveName: name.get(s.executiveId) ?? "(removed)", ratePercent: s.rateBp / 100 })),
  };
}

