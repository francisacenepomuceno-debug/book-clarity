import type { ClientStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";

export type PackageSlots = {
  packageId: string;
  name: string;
  bought: number;
  used: number;
  available: number;
  /** Of the available slots, how many are in batches ACE hasn't paid yet. */
  availableInUnpaidBatches: number;
};

export type AssignedSlot = {
  slotId: string;
  batchId: string;
  batchPaid: boolean;
  clientId: string;
  clientName: string;
  companyName: string | null;
  email: string | null;
  batchNote: string | null;
  status: ClientStatus;
  packageId: string;
  packageName: string;
  startDate: Date | null;
  prepaidUntil: Date | null;
  continuationDecision: string | null;
};

/** ACE overview across all batches: slot availability per package, and which client holds which slot. */
export async function aceSlotOverview(filter: { packageId?: string } = {}): Promise<{ byPackage: PackageSlots[]; assigned: AssignedSlot[] }> {
  await requirePermission("ace.manage");
  const [slots, batches, packages] = await Promise.all([
    db.aceSlot.findMany(),
    db.aceBatch.findMany({ select: { id: true, paidAt: true, note: true, purchasedAt: true } }),
    db.package.findMany(),
  ]);
  const paid = new Map(batches.map((b) => [b.id, b.paidAt !== null]));
  const batchNote = new Map(batches.map((b) => [b.id, b.note]));
  const pkgName = new Map(packages.map((p) => [p.id, p.name]));
  const clientIds = slots.flatMap((s) => (s.clientId ? [s.clientId] : []));
  const clients = new Map((await db.client.findMany({ where: { id: { in: clientIds } } })).map((c) => [c.id, c]));

  const byPackage = new Map<string, PackageSlots>();
  for (const s of slots) {
    const row = byPackage.get(s.packageId) ?? {
      packageId: s.packageId,
      name: pkgName.get(s.packageId) ?? "?",
      bought: 0,
      used: 0,
      available: 0,
      availableInUnpaidBatches: 0,
    };
    row.bought += 1;
    if (s.clientId) row.used += 1;
    else {
      row.available += 1;
      if (!paid.get(s.batchId)) row.availableInUnpaidBatches += 1;
    }
    byPackage.set(s.packageId, row);
  }

  const assigned: AssignedSlot[] = slots
    .filter((s) => s.clientId && clients.has(s.clientId) && (!filter.packageId || s.packageId === filter.packageId))
    .map((s) => {
      const c = clients.get(s.clientId!)!;
      return {
        slotId: s.id,
        batchId: s.batchId,
        batchPaid: paid.get(s.batchId) ?? false,
        clientId: c.id,
        clientName: c.name,
        companyName: c.companyName,
        email: c.email,
        batchNote: batchNote.get(s.batchId) ?? null,
        status: c.status,
        packageId: s.packageId,
        packageName: pkgName.get(s.packageId) ?? "?",
        startDate: s.startDate,
        prepaidUntil: s.prepaidUntil,
        continuationDecision: c.continuationDecision,
      };
    })
    .sort((a, b) => (a.companyName || a.clientName).localeCompare(b.companyName || b.clientName));

  return {
    byPackage: [...byPackage.values()].sort((a, b) => a.name.localeCompare(b.name)),
    assigned,
  };
}
