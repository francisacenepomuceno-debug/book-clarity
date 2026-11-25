import type { Invoice, Prisma } from "@prisma/client";
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

type Tx = Prisma.TransactionClient;

/** Serialises ledger writes and statement payouts for one executive (transaction-scoped Postgres lock). */
export async function lockExecutive(tx: Tx, executiveId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${executiveId}))`;
}

/** The month an entry posts to: its own month, unless that executive already has a paid statement for it or later. */
export async function postingMonthFor(executiveId: string, eventMonth: string, tx: Tx = db): Promise<string> {
  const latestPaid = await tx.commissionStatement.findFirst({
    where: { executiveId, status: "PAID" },
    orderBy: { month: "desc" },
    select: { month: true },
  });
  if (!latestPaid || eventMonth > latestPaid.month) return eventMonth;
  return nextMonth(latestPaid.month);
}

/**
 * The commission window an invoice belongs to. A client can pay for several packages, each its own Stripe
 * subscription; each has its own window (owner, 2026-11-22):
 * - the main subscription (the client's bookkeeping package): 12 paid months for Direct clients, 6 after the ACE
 *   months for ACE clients, less the months already earned before the portal;
 * - any other package: its own 12 paid months from its first payment.
 * Invoices with no subscription recorded (older rows) count as the main one.
 */
export function commissionGroup(
  client: { type: "DIRECT" | "ACE"; stripeSubscriptionId: string | null; commissionMonthsBeforePortal: number },
  subscriptionId: string | null,
  /** For another package: its own paid months already earned before the portal. */
  packageMonthsBefore = 0,
) {
  const isMain = !subscriptionId || !client.stripeSubscriptionId || subscriptionId === client.stripeSubscriptionId;
  if (isMain) {
    return {
      isMain,
      windowMonths: windowMonthsFor(client),
      monthsBefore: client.commissionMonthsBeforePortal,
      // No main subscription known: every invoice counts as the main package.
      invoiceWhere: (client.stripeSubscriptionId
        ? { OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: client.stripeSubscriptionId }] }
        : {}) as Prisma.InvoiceWhereInput,
    };
  }
  return { isMain, windowMonths: 12, monthsBefore: packageMonthsBefore, invoiceWhere: { stripeSubscriptionId: subscriptionId } as Prisma.InvoiceWhereInput };
}

const isEarlier = (a: Invoice, b: Invoice) =>
  a.paidAt!.getTime() < b.paidAt!.getTime() || (a.paidAt!.getTime() === b.paidAt!.getTime() && a.id < b.id);

/**
 * Records commission for one cleared subscription payment. Returns the number of new ledger lines.
 * One set of lines per invoice: once an invoice has earned, later split changes never add to it.
 * Runs under the client's lock so the window (12 paid months) can't be overfilled by concurrent or late payments.
 */
export async function recordPaymentCommission(invoiceRowId: string): Promise<number> {
  const first = await db.invoice.findUnique({ where: { id: invoiceRowId }, select: { clientId: true } });
  if (!first?.clientId) return 0;
  const clientId = first.clientId;

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"client:" + clientId}))`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceRowId } });
    // History copied in by the backfill is already covered by "months before the portal".
    if (!inv || inv.backfilled || inv.kind !== "SUBSCRIPTION" || inv.status !== "paid" || !inv.paidAt) return 0;
    if (await tx.commissionEntry.count({ where: { invoiceId: inv.id, kind: "EARNED" } })) return 0;

    const client = await tx.client.findUniqueOrThrow({ where: { id: clientId } });
    const base = packagePaidCents(inv);
    if (base <= 0) return 0;

    const split = splitAt(await tx.commissionShare.findMany({ where: { clientId } }), inv.paidAt);
    if (split.length === 0) return 0;

    // Each package (Stripe subscription) has its own commission window (owner, 2026-11-22).
    const pkgRow = inv.stripeSubscriptionId && inv.stripeSubscriptionId !== client.stripeSubscriptionId
      ? await tx.clientSubscription.findUnique({ where: { stripeSubscriptionId: inv.stripeSubscriptionId }, select: { commissionMonthsBeforePortal: true } })
      : null;
    const group = commissionGroup(client, inv.stripeSubscriptionId, pkgRow?.commissionMonthsBeforePortal ?? 0);
    const windowMonths = group.windowMonths;
    const groupInvoiceIds = (await tx.invoice.findMany({ where: { clientId, ...group.invoiceWhere }, select: { id: true } })).map((i) => i.id);
    // Hard cap: months earned before the portal + invoices that have already earned.
    const earnedInvoices = await tx.commissionEntry.findMany({
      where: { clientId, kind: "EARNED", invoiceId: { in: groupInvoiceIds } },
      distinct: ["invoiceId"],
      select: { invoiceId: true },
    });
    if (group.monthsBefore + earnedInvoices.length >= windowMonths) return 0;

    // Which paid month this is (chronological): months before the portal + earlier paid months with a package amount.
    const paid = await tx.invoice.findMany({ where: { clientId, kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null }, backfilled: false, ...group.invoiceWhere } });
    const earlier = paid.filter((p) => p.id !== inv.id && packagePaidCents(p) > 0 && isEarlier(p, inv)).length;
    const paidIndex = group.monthsBefore + earlier + 1;

    const lines = earnedLines({ baseCents: base, paidIndex, windowMonths, split });
    if (lines.length === 0) return 0;

    return postEntries(
      tx,
      monthOf(inv.paidAt, tz()),
      lines.map((l) => ({
        executiveId: l.executiveId,
        clientId,
        invoiceId: inv.id,
        kind: "EARNED" as const,
        windowIndex: paidIndex,
        baseCents: base,
        rateBp: l.rateBp,
        amountCents: l.amountCents,
        occurredAt: inv.paidAt!,
      })),
    );
  });
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
  return db.$transaction((tx) =>
    postEntries(
    tx,
    monthOf(at, tz()),
    lines.map((l) => ({
      executiveId: l.executiveId,
      clientId: inv.clientId!,
      invoiceId: inv.id,
      kind: "CLAWBACK" as const,
      refundKey: refund.refundKey,
      baseCents: -refund.packageCents,
      rateBp: l.rateBp,
      amountCents: l.amountCents,
      occurredAt: at,
    })),
    ),
  );
}

/** Writes ledger lines inside `tx`, under each executive's lock so a statement can't be frozen mid-write. Idempotent. */
async function postEntries(tx: Tx, eventMonth: string, lines: Omit<Prisma.CommissionEntryCreateManyInput, "month">[]): Promise<number> {
  let created = 0;
  for (const line of [...lines].sort((a, b) => a.executiveId.localeCompare(b.executiveId))) {
    await lockExecutive(tx, line.executiveId);
    const month = await postingMonthFor(line.executiveId, eventMonth, tx);
    created += (await tx.commissionEntry.createMany({ data: [{ ...line, month }], skipDuplicates: true })).count;
  }
  return created;
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

/**
 * Re-does a client's commission in months not yet paid: their payment lines there are removed and posted again with
 * the client's current split and months already earned. Paid months are never touched. Used by the commission
 * import, so a corrected file fixes lines an earlier import posted.
 */
export async function recalculateOpenCommission(clientId: string): Promise<number> {
  const paidStatements = await db.commissionStatement.findMany({ where: { status: "PAID" }, select: { executiveId: true, month: true } });
  const paidKey = new Set(paidStatements.map((s) => `${s.executiveId}|${s.month}`));
  const lines = await db.commissionEntry.findMany({ where: { clientId, kind: "EARNED" }, select: { id: true, executiveId: true, month: true, invoiceId: true } });
  const open = lines.filter((l) => !paidKey.has(`${l.executiveId}|${l.month}`));
  // An invoice with a line in a paid month stays as it is (all its lines), so nothing is paid twice.
  const lockedInvoices = new Set(lines.filter((l) => paidKey.has(`${l.executiveId}|${l.month}`)).map((l) => l.invoiceId));
  const remove = open.filter((l) => !lockedInvoices.has(l.invoiceId)).map((l) => l.id);
  if (remove.length) await db.commissionEntry.deleteMany({ where: { id: { in: remove } } });
  return recomputeClient(clientId);
}
