import type { Invoice } from "@prisma/client";
import { db } from "@/lib/db";
import {
  clawbackLines,
  earnedLines,
  monthOf,
  nextMonth,
  packagePaidCents,
  splitAt,
  windowMonthsFor,
} from "@/domain/commission";

const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";

/** The month an entry posts to: its own month, unless that executive already has a paid statement for it or later. */
export async function postingMonthFor(executiveId: string, eventMonth: string): Promise<string> {
  const latestPaid = await db.commissionStatement.findFirst({
    where: { executiveId, status: "PAID" },
    orderBy: { month: "desc" },
    select: { month: true },
  });
  if (!latestPaid || eventMonth > latestPaid.month) return eventMonth;
  return nextMonth(latestPaid.month);
}

const isEarlier = (a: Invoice, b: Invoice) =>
  a.paidAt!.getTime() < b.paidAt!.getTime() || (a.paidAt!.getTime() === b.paidAt!.getTime() && a.id < b.id);

/** Records commission for one cleared subscription payment. Returns the number of new ledger lines. */
export async function recordPaymentCommission(invoiceRowId: string): Promise<number> {
  const inv = await db.invoice.findUnique({ where: { id: invoiceRowId } });
  if (!inv?.clientId || inv.kind !== "SUBSCRIPTION" || inv.status !== "paid" || !inv.paidAt) return 0;
  const client = await db.client.findUniqueOrThrow({ where: { id: inv.clientId } });

  const base = packagePaidCents(inv);
  if (base <= 0) return 0;

  const shares = await db.commissionShare.findMany({ where: { clientId: client.id } });
  const split = splitAt(shares, inv.paidAt);
  if (split.length === 0) return 0;

  // Which paid month this is: months earned before the portal + earlier paid months with a package amount.
  const paid = await db.invoice.findMany({
    where: { clientId: client.id, kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null } },
  });
  const earlier = paid.filter((p) => p.id !== inv.id && packagePaidCents(p) > 0 && isEarlier(p, inv)).length;
  const paidIndex = client.commissionMonthsBeforePortal + earlier + 1;

  const lines = earnedLines({ baseCents: base, paidIndex, windowMonths: windowMonthsFor(client), split });
  if (lines.length === 0) return 0;

  const eventMonth = monthOf(inv.paidAt, tz());
  const data = await Promise.all(
    lines.map(async (l) => ({
      executiveId: l.executiveId,
      clientId: client.id,
      invoiceId: inv.id,
      kind: "EARNED" as const,
      windowIndex: paidIndex,
      baseCents: base,
      rateBp: l.rateBp,
      amountCents: l.amountCents,
      occurredAt: inv.paidAt!,
      month: await postingMonthFor(l.executiveId, eventMonth),
    })),
  );
  return (await db.commissionEntry.createMany({ data, skipDuplicates: true })).count;
}

/** Claws back commission for a refund on an invoice, proportionally and at most what was earned. */
export async function recordRefundClawback(
  invoiceRowId: string,
  refund: { refundKey: string; packageCents: number; at?: Date },
): Promise<number> {
  const inv = await db.invoice.findUnique({ where: { id: invoiceRowId } });
  if (!inv?.clientId) return 0;
  const existing = await db.commissionEntry.findMany({ where: { invoiceId: inv.id } });
  const originals = existing.filter((e) => e.kind === "EARNED");
  if (originals.length === 0 || existing.some((e) => e.kind === "CLAWBACK" && e.refundKey === refund.refundKey)) return 0;

  const alreadyClawedByExec: Record<string, number> = {};
  for (const e of existing.filter((x) => x.kind === "CLAWBACK")) {
    alreadyClawedByExec[e.executiveId] = (alreadyClawedByExec[e.executiveId] ?? 0) - e.amountCents;
  }
  const lines = clawbackLines({
    originals,
    refundPackageCents: refund.packageCents,
    invoicePackageCents: originals[0].baseCents,
    alreadyClawedByExec,
  });
  if (lines.length === 0) return 0;

  const at = refund.at ?? new Date();
  const eventMonth = monthOf(at, tz());
  const data = await Promise.all(
    lines.map(async (l) => ({
      executiveId: l.executiveId,
      clientId: inv.clientId!,
      invoiceId: inv.id,
      kind: "CLAWBACK" as const,
      refundKey: refund.refundKey,
      baseCents: -refund.packageCents,
      rateBp: l.rateBp,
      amountCents: l.amountCents,
      occurredAt: at,
      month: await postingMonthFor(l.executiveId, eventMonth),
    })),
  );
  return (await db.commissionEntry.createMany({ data, skipDuplicates: true })).count;
}

/** Re-runs commission for all of a client's paid invoices (idempotent). Used after a split is set or changed. */
export async function recomputeClient(clientId: string): Promise<number> {
  const paid = await db.invoice.findMany({
    where: { clientId, kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null } },
    orderBy: [{ paidAt: "asc" }, { id: "asc" }],
  });
  let created = 0;
  for (const inv of paid) created += await recordPaymentCommission(inv.id);
  return created;
}
