import type { ClientStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { validateSplit } from "@/domain/commission";
import { recomputeClient } from "@/commissions/engine";
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
