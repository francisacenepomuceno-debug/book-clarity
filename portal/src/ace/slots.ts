import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { aceLumpBase, prepaidUntil } from "@/domain/ace";
import { monthOf, splitAt, startOfDayIn } from "@/domain/commission";
import { percentOfCents } from "@/lib/money";
import { lockExecutive, postingMonthFor } from "@/commissions/engine";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";
export const aceSlotInvoiceKey = (slotId: string) => `ace-slot:${slotId}`;

/**
 * Puts a client into an open slot of a batch. The 6 prepaid months start on `startOn` (their onboarding date).
 * Open slots are claimed with FOR UPDATE SKIP LOCKED so the last slot can only go to one client.
 */
export async function assignSlot(i: {
  batchId: string;
  packageId: string;
  clientId: string;
  startOn: string;
  customMonthlyCents?: number;
  /** Required to put a client who is already on Stripe autopay into a slot (e.g. a historical assignment). */
  confirmSubscribed?: boolean;
}): Promise<ActionResult<{ slotId: string }>> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startOn)) return { ok: false, error: "Pick the client's onboarding (start) date." };
  const pkg = await db.package.findUnique({ where: { id: i.packageId } });
  if (!pkg) return { ok: false, error: "Pick a package." };
  if (pkg.isCustom && !(Number.isInteger(i.customMonthlyCents) && i.customMonthlyCents! > 0)) {
    return { ok: false, error: "Enter this client's Custom monthly price." };
  }
  const until = prepaidUntil(i.startOn, tz());
  const startDate = startOfDayIn(i.startOn, tz());

  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"client:" + i.clientId}))`;
    const client = await tx.client.findUnique({ where: { id: i.clientId } });
    if (!client) return { ok: false as const, error: "Client not found." };
    if (client.aceSlotId || (await tx.aceSlot.findUnique({ where: { clientId: i.clientId } }))) {
      return { ok: false as const, error: "This client already has an ACE slot." };
    }
    if (client.stripeSubscriptionId && until > new Date() && !i.confirmSubscribed) {
      return {
        ok: false as const,
        error:
          "This client is on autopay, so Stripe would keep charging them during the prepaid months. Pause or cancel their subscription in Stripe first, or tick the confirmation box if this is a past (historical) assignment.",
      };
    }
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AceSlot"
      WHERE "batchId" = ${i.batchId} AND "packageId" = ${i.packageId} AND "clientId" IS NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (open.length === 0) return { ok: false as const, error: `No open ${pkg.name} slots left in this batch.` };
    const slotId = open[0].id;
    await tx.aceSlot.update({
      where: { id: slotId },
      data: { clientId: i.clientId, startDate, prepaidUntil: until, customMonthlyCents: pkg.isCustom ? i.customMonthlyCents! : null },
    });
    await tx.client.update({
      where: { id: i.clientId },
      data: { type: "ACE", acePrepaidUntil: until, aceSlotId: slotId, packageId: pkg.id },
    });
    return { ok: true as const, slotId };
  });
  if (!result.ok) return result;

  await refreshClientStatus(i.clientId);
  await writeAudit({ actorId: actor.id, action: "ace_slot_assigned", entity: "Client", entityId: i.clientId, after: { ...i, prepaidUntil: until } });
  await postAceCommission(result.slotId);
  return result;
}

/**
 * ACE months 1–6 commission for one slot: 6 × the package's monthly list price (Custom: the slot's price),
 * at the client's split on the start date. Pending (no-op) until the slot is filled and the batch is paid.
 */
export async function postAceCommission(slotId: string): Promise<number> {
  const slot = await db.aceSlot.findUnique({ where: { id: slotId } });
  if (!slot) return 0;
  const batch = await db.aceBatch.findUniqueOrThrow({ where: { id: slot.batchId } });
  if (batch.commissionExecutiveId && batch.commissionRateBp) return postBatchSlotCommission(slot, batch);
  if (!slot.clientId || !slot.startDate) return 0;
  // Historical batches (entered at migration): the months 1–6 commission was settled outside the portal.
  if (!batch.paidAt || batch.historical) return 0;
  const pkg = await db.package.findUniqueOrThrow({ where: { id: slot.packageId } });
  const base = aceLumpBase({ monthlyListCents: slot.customMonthlyCents ?? pkg.monthlyPriceCents });
  if (base <= 0) return 0;
  const shares = await db.commissionShare.findMany({ where: { clientId: slot.clientId } });
  // Owners are usually set after the start date (new ACE clients, historical slots): if no version covers the
  // start date, use the earliest one.
  let split = splitAt(shares, slot.startDate);
  if (split.length === 0 && shares.length > 0) {
    split = splitAt(shares, new Date(Math.min(...shares.map((s) => s.effectiveFrom.getTime()))));
  }
  if (split.length === 0) return 0;

  const occurredAt = batch.paidAt > slot.startDate ? batch.paidAt : slot.startDate;
  const eventMonth = monthOf(occurredAt, tz());
  return db.$transaction(async (tx) => {
    // One lump per slot: once it has posted, later split changes never add to it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${aceSlotInvoiceKey(slot.id)}))`;
    if (await tx.commissionEntry.count({ where: { invoiceId: aceSlotInvoiceKey(slot.id), kind: "ACE_PREPAID" } })) return 0;
    let created = 0;
    for (const s of [...split].sort((a, b) => a.executiveId.localeCompare(b.executiveId))) {
      await lockExecutive(tx, s.executiveId);
      const month = await postingMonthFor(s.executiveId, eventMonth, tx);
      created += (
        await tx.commissionEntry.createMany({
          data: [{
            executiveId: s.executiveId,
            clientId: slot.clientId!,
            invoiceId: aceSlotInvoiceKey(slot.id),
            kind: "ACE_PREPAID",
            baseCents: base,
            rateBp: s.rateBp,
            amountCents: percentOfCents(base, s.rateBp),
            occurredAt,
            month,
          }],
          skipDuplicates: true,
        })
      ).count;
    }
    return created;
  });
}

/** Placeholder client id on a batch commission line whose slot has no client yet. */
export const aceBatchClientKey = (batchId: string) => `ace-batch:${batchId}`;

/**
 * Batch rule: the batch's executive earns their rate on each slot ACE paid for (its price less the package's
 * onboarding fee), in the month ACE paid, whether or not a client is in the slot yet. Once a client is placed,
 * the line is relabelled with them.
 */
async function postBatchSlotCommission(
  slot: { id: string; batchId: string; packageId: string; clientId: string | null },
  batch: { id: string; paidAt: Date | null; historical: boolean; commissionExecutiveId: string | null; commissionRateBp: number | null },
): Promise<number> {
  const key = aceSlotInvoiceKey(slot.id);
  if (slot.clientId) {
    await db.commissionEntry.updateMany({ where: { invoiceId: key, kind: "ACE_PREPAID", clientId: aceBatchClientKey(batch.id) }, data: { clientId: slot.clientId } });
  }
  if (!batch.paidAt || batch.historical) return 0;
  const execId = batch.commissionExecutiveId!;
  const rateBp = batch.commissionRateBp!;
  const [line, pkg] = await Promise.all([
    db.aceBatchLine.findFirst({ where: { batchId: batch.id, packageId: slot.packageId } }),
    db.package.findUniqueOrThrow({ where: { id: slot.packageId } }),
  ]);
  const base = Math.max(0, (line?.unitPriceCents ?? 0) - pkg.onboardingFeeCents);
  if (base <= 0) return 0;
  const occurredAt = batch.paidAt;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    if (await tx.commissionEntry.count({ where: { invoiceId: key, kind: "ACE_PREPAID" } })) return 0;
    await lockExecutive(tx, execId);
    const month = await postingMonthFor(execId, monthOf(occurredAt, tz()), tx);
    return (
      await tx.commissionEntry.createMany({
        data: [{ executiveId: execId, clientId: slot.clientId ?? aceBatchClientKey(batch.id), invoiceId: key, kind: "ACE_PREPAID", baseCents: base, rateBp, amountCents: percentOfCents(base, rateBp), occurredAt, month }],
        skipDuplicates: true,
      })
    ).count;
  });
}

export async function postAceCommissionsForBatch(batchId: string): Promise<number> {
  const batch = await db.aceBatch.findUnique({ where: { id: batchId } });
  const slots = await db.aceSlot.findMany({ where: { batchId, ...(batch?.commissionExecutiveId ? {} : { clientId: { not: null } }) }, select: { id: true } });
  let created = 0;
  for (const s of slots) created += await postAceCommission(s.id);
  return created;
}

/** Labels for ACE batch commission lines whose slot has no client yet: "Cohort 2 C: open Growth slot". */
export async function openSlotLabels(entries: { clientId: string; invoiceId: string }[]): Promise<Map<string, string>> {
  const slotIds = entries.filter((e) => e.clientId.startsWith("ace-batch:") && e.invoiceId.startsWith("ace-slot:")).map((e) => e.invoiceId.slice("ace-slot:".length));
  if (!slotIds.length) return new Map();
  const slots = await db.aceSlot.findMany({ where: { id: { in: slotIds } } });
  const [batches, packages] = await Promise.all([
    db.aceBatch.findMany({ where: { id: { in: slots.map((s) => s.batchId) } } }),
    db.package.findMany({ where: { id: { in: slots.map((s) => s.packageId) } } }),
  ]);
  return new Map(
    slots.map((s) => {
      const b = batches.find((x) => x.id === s.batchId);
      const batchName = b?.note || (b ? `ACE batch of ${b.purchasedAt.toISOString().slice(0, 10)}` : "ACE batch");
      return [aceSlotInvoiceKey(s.id), `${batchName}: open ${packages.find((p) => p.id === s.packageId)?.name ?? ""} slot`];
    }),
  );
}
