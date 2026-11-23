import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { monthOf, packagePaidCents, splitAt, windowMonthsFor } from "@/domain/commission";
import { commissionGroup } from "@/commissions/engine";
import { subscriptionsOf } from "@/clients/subscriptions";
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
  const clients = await db.client.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.clientId))] } }, select: { id: true, name: true, type: true, stripeSubscriptionId: true, commissionMonthsBeforePortal: true } });
  const invoices = await db.invoice.findMany({ where: { id: { in: entries.map((e) => e.invoiceId) } }, select: { id: true, stripeInvoiceId: true, stripeSubscriptionId: true } });
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const stripeId = new Map(invoices.map((i) => [i.id, i.stripeInvoiceId]));
  const subOf = new Map(invoices.map((i) => [i.id, i.stripeSubscriptionId]));
  // Each package has its own window (the main package's depends on Direct/ACE; others are 12 months).
  const windowOf = (e: { clientId: string; invoiceId: string }) => {
    const c = clientById.get(e.clientId);
    return c ? commissionGroup(c, subOf.get(e.invoiceId) ?? null).windowMonths : windowMonthsFor({ type: "DIRECT" });
  };
  return entries.map((e) => ({
    clientName: clientName.get(e.clientId) ?? "(unknown client)",
    invoiceId: stripeId.get(e.invoiceId) ?? e.invoiceId,
    kind: e.kind,
    occurredAt: e.occurredAt,
    baseCents: e.baseCents,
    rateBp: e.rateBp,
    amountCents: e.amountCents,
    windowIndex: e.windowIndex,
    windowMonths: windowOf(e),
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

/**
 * How far a client is through their commission windows, and who earns on them now. The main package comes first;
 * each other package the client pays for has its own window (owner, 2026-11-22).
 */
export async function commissionProgress(clientId: string) {
  await requirePermission("commissions.view");
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const paid = await db.invoice.findMany({ where: { clientId, kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null }, backfilled: false } });
  const subs = await subscriptionsOf(client);
  const pkgs = await db.package.findMany({ where: { id: { in: subs.flatMap((s) => (s.packageId ? [s.packageId] : [])) } } });
  const pkgName = new Map(pkgs.map((p) => [p.id, p.name]));
  const monthsBeforeOf = new Map(subs.map((s) => [s.subscriptionId, s.monthsBeforePortal]));
  const progressFor = (subscriptionId: string | null) => {
    const g = commissionGroup(client, subscriptionId, (subscriptionId && monthsBeforeOf.get(subscriptionId)) || 0);
    const mine = paid.filter((p) => (g.isMain ? !client.stripeSubscriptionId || !p.stripeSubscriptionId || p.stripeSubscriptionId === client.stripeSubscriptionId : p.stripeSubscriptionId === subscriptionId));
    const earnedMonths = Math.min(g.windowMonths, g.monthsBefore + mine.filter((p) => packagePaidCents(p) > 0).length);
    return { windowMonths: g.windowMonths, earnedMonths, remainingMonths: g.windowMonths - earnedMonths };
  };
  const main = progressFor(client.stripeSubscriptionId);
  const otherPackages = subs
    .filter((s) => !s.isMain)
    .map((s) => ({ subscriptionId: s.subscriptionId, packageName: (s.packageId && pkgName.get(s.packageId)) || s.productName || "Other package", ended: !!s.endedAt, monthsBeforePortal: s.monthsBeforePortal, ...progressFor(s.subscriptionId) }));
  const shares = await db.commissionShare.findMany({ where: { clientId } });
  const execs = await db.executive.findMany({ where: { id: { in: shares.map((s) => s.executiveId) } } });
  const name = new Map(execs.map((e) => [e.id, e.name]));
  return {
    ...main,
    mainPackageName: subs.find((s) => s.isMain)?.packageId ? pkgName.get(subs.find((s) => s.isMain)!.packageId!) ?? null : null,
    otherPackages,
    split: splitAt(shares, new Date()).map((s) => ({ executiveName: name.get(s.executiveId) ?? "(removed)", ratePercent: s.rateBp / 100 })),
  };
}

