import type { ClientStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { validateSplit } from "@/domain/commission";
import { recomputeClient } from "@/commissions/engine";
import { postAceCommission } from "@/ace/slots";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that." };

async function owner() {
  try {
    return await requirePermission("commissions.markPaid");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

export async function addExecutive(name: string): Promise<ActionResult<{ executiveId: string }>> {
  const actor = await owner();
  if (!actor) return FORBIDDEN;
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) return { ok: false, error: "Enter a name." };
  if (await db.executive.findFirst({ where: { name: { equals: clean, mode: "insensitive" } } })) {
    return { ok: false, error: `${clean} is already on the list.` };
  }
  const e = await db.executive.create({ data: { name: clean } });
  await writeAudit({ actorId: actor.id, action: "executive_added", entity: "Executive", entityId: e.id, after: { name: clean } });
  return { ok: true, executiveId: e.id };
}

/**
 * Owners: merges a duplicate executive into another (e.g. "Albert" into "Albert Assad"). Their commission splits,
 * ledger lines and statements move over, then the duplicate is removed. A line both already have is kept once.
 */
export async function mergeExecutive(fromId: string, intoId: string): Promise<ActionResult> {
  const actor = await owner();
  if (!actor) return FORBIDDEN;
  if (!fromId || !intoId || fromId === intoId) return { ok: false, error: "Choose a different executive to merge into." };
  const [from, into] = await Promise.all([db.executive.findUnique({ where: { id: fromId } }), db.executive.findUnique({ where: { id: intoId } })]);
  if (!from || !into) return { ok: false, error: "Executive not found. Refresh and try again." };
  const moved = await db.$transaction(async (tx) => {
    const shares = await tx.commissionShare.updateMany({ where: { executiveId: fromId }, data: { executiveId: intoId } });
    let lines = 0;
    for (const e of await tx.commissionEntry.findMany({ where: { executiveId: fromId } })) {
      const dup = await tx.commissionEntry.findFirst({ where: { executiveId: intoId, invoiceId: e.invoiceId, kind: e.kind, refundKey: e.refundKey } });
      if (dup) await tx.commissionEntry.delete({ where: { id: e.id } });
      else { await tx.commissionEntry.update({ where: { id: e.id }, data: { executiveId: intoId } }); lines++; }
    }
    for (const s of await tx.commissionStatement.findMany({ where: { executiveId: fromId } })) {
      const other = await tx.commissionStatement.findUnique({ where: { executiveId_month: { executiveId: intoId, month: s.month } } });
      if (!other) await tx.commissionStatement.update({ where: { id: s.id }, data: { executiveId: intoId } });
      else {
        // Both had a statement for the month: one stays; it counts as paid if either was paid.
        if (s.status === "PAID" && other.status !== "PAID") {
          await tx.commissionStatement.update({ where: { id: other.id }, data: { status: "PAID", paidAt: s.paidAt, paidById: s.paidById, totalCents: (other.totalCents ?? 0) + (s.totalCents ?? 0) } });
        }
        await tx.commissionStatement.delete({ where: { id: s.id } });
      }
    }
    await tx.executive.delete({ where: { id: fromId } });
    return { shares: shares.count, lines };
  });
  await writeAudit({ actorId: actor.id, action: "executive_merged", entity: "Executive", entityId: intoId, before: { name: from.name, id: fromId }, after: { into: into.name, ...moved } });
  return { ok: true };
}

/**
 * Sets who earns commission on a client from a date forward (a new split version; old versions are kept),
 * optionally records paid months already earned before the portal, then records any commission now due.
 */
export async function setClientCommission(
  clientId: string,
  input: { shares: { executiveId: string; ratePercent: number }[]; effectiveFrom: Date; monthsBeforePortal?: number },
): Promise<ActionResult> {
  const actor = await owner();
  if (!actor) return FORBIDDEN;

  const shares = input.shares.map((s) => ({ executiveId: s.executiveId, rateBp: Math.round(s.ratePercent * 100) }));
  if (input.shares.some((s) => Math.abs(s.ratePercent * 100 - Math.round(s.ratePercent * 100)) > 1e-9)) {
    return { ok: false, error: "Use at most two decimal places for percentages." };
  }
  const v = validateSplit(shares);
  if (!v.ok) return v;
  const execs = await db.executive.findMany({ where: { id: { in: shares.map((s) => s.executiveId) }, active: true } });
  if (execs.length !== shares.length) return { ok: false, error: "Pick executives from the list." };
  if (input.monthsBeforePortal !== undefined && (!Number.isInteger(input.monthsBeforePortal) || input.monthsBeforePortal < 0 || input.monthsBeforePortal > 12)) {
    return { ok: false, error: "Months already earned must be a whole number from 0 to 12." };
  }
  if (Number.isNaN(input.effectiveFrom.getTime())) return { ok: false, error: "Pick a valid start date." };

  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) return { ok: false, error: "Client not found." };
  const before = {
    shares: await db.commissionShare.findMany({ where: { clientId }, orderBy: { effectiveFrom: "asc" } }),
    monthsBeforePortal: client.commissionMonthsBeforePortal,
  };

  await db.$transaction(async (tx) => {
    // A second save for the same start date is a correction: it replaces that version instead of adding to it.
    await tx.commissionShare.deleteMany({ where: { clientId, effectiveFrom: input.effectiveFrom } });
    await tx.commissionShare.createMany({
      data: shares.map((s) => ({ ...s, clientId, effectiveFrom: input.effectiveFrom, createdById: actor.id })),
    });
    if (input.monthsBeforePortal !== undefined) {
      await tx.client.update({ where: { id: clientId }, data: { commissionMonthsBeforePortal: input.monthsBeforePortal } });
    }
  });
  await writeAudit({
    actorId: actor.id,
    action: "commission_split_set",
    entity: "Client",
    entityId: clientId,
    before,
    after: { shares, effectiveFrom: input.effectiveFrom, monthsBeforePortal: input.monthsBeforePortal ?? client.commissionMonthsBeforePortal },
  });
  await recomputeClient(clientId);
  const slot = await db.aceSlot.findUnique({ where: { clientId }, select: { id: true } });
  if (slot) await postAceCommission(slot.id);
  return { ok: true };
}

export async function unassignedClients(): Promise<{ id: string; name: string; status: ClientStatus; stripeSubscriptionId: string | null }[]> {
  const assigned = await db.commissionShare.findMany({ distinct: ["clientId"], select: { clientId: true } });
  return db.client.findMany({
    where: { status: { not: "ENDED" }, id: { notIn: assigned.map((a) => a.clientId) } },
    select: { id: true, name: true, status: true, stripeSubscriptionId: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Owners / Super Admin: paid months of a client's additional package that already earned commission before the
 * portal (each package has its own 12-month window). Records any commission now due on that package.
 */
export async function setPackageMonthsBeforePortal(subscriptionId: string, months: number): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("commissions.markPaid");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  if (!Number.isInteger(months) || months < 0 || months > 12) return { ok: false, error: "Months already earned must be a whole number from 0 to 12." };
  const row = await db.clientSubscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, include: { client: true } });
  if (!row) return { ok: false, error: "Package not found. Refresh and try again." };
  if (row.client.stripeSubscriptionId === subscriptionId) return { ok: false, error: "This is the main package: set its months in the commission form above." };
  if (row.commissionMonthsBeforePortal === months) return { ok: true };
  await db.clientSubscription.update({ where: { id: row.id }, data: { commissionMonthsBeforePortal: months } });
  await writeAudit({ actorId: actor.id, action: "package_commission_months_set", entity: "Client", entityId: row.clientId, before: { subscriptionId, months: row.commissionMonthsBeforePortal }, after: { subscriptionId, months } });
  await recomputeClient(row.clientId);
  return { ok: true };
}
