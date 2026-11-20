import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";

export type AuditQuery = { action?: string; actorId?: string; entityId?: string; cursor?: string; limit?: number };

/** Top-level keys whose values differ between before and after. */
export function changedKeys(before: unknown, after: unknown): string[] {
  const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k])).sort();
}

/** Owners and Super Admin: the audit log, newest first, 50 per page (keyset pagination on time + id). */
export async function listAudit(q: AuditQuery) {
  await requirePermission("audit.view");
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.action ? { action: q.action } : {}),
    ...(q.actorId ? { actorId: q.actorId === "system" ? null : q.actorId } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
  };
  if (q.cursor) {
    const [iso, id] = q.cursor.split("|");
    const at = new Date(iso);
    if (!Number.isNaN(at.getTime()) && id) where.OR = [{ at: { lt: at } }, { at, id: { lt: id } }];
  }
  const [rows, users, actions] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], take: limit + 1 }),
    db.user.findMany({ select: { id: true, name: true } }),
    db.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((r) => ({ ...r, actorName: r.actorId ? names.get(r.actorId) ?? "Former user" : "System", changed: changedKeys(r.before, r.after) })),
    next: rows.length > limit && last ? `${last.at.toISOString()}|${last.id}` : null,
    actions: actions.map((a) => a.action),
    people: users,
  };
}
