import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";

export const MESSAGE_KIND_LABEL: Record<string, string> = {
  "onboarding-invite": "Onboarding invite",
  "onboarding-nudge": "Onboarding reminder",
  "onboarding-fee-failed": "Onboarding fee payment failed",
  "countersign-request": "Countersign request (staff)",
  "countersign-reminder": "Countersign reminder (staff)",
  "contract-executed": "Signed agreement",
  "contract-executed-copy": "Signed agreement copy (staff)",
  "contract-executed-staff": "Signed agreement copy (staff)",
  upcoming_charge: "Upcoming charge",
  price_increase: "Price increase notice",
  suspended: "Service suspended",
  suspended_staff: "Client suspended (staff)",
  owner_at_risk: "Client at risk (owners)",
  ace_setup_14: "ACE: set up payment (14 days)",
};

/** A readable name for a message type, including the ones that carry a day or step in their name. */
export function messageKindLabel(kind: string): string {
  if (MESSAGE_KIND_LABEL[kind]) return MESSAGE_KIND_LABEL[kind];
  if (kind.startsWith("payment_failed_")) return `Payment failed (day ${kind.slice("payment_failed_".length)})`;
  if (kind.startsWith("ace_ending_")) return "ACE program ending";
  if (kind.startsWith("ace_batch_unpaid_")) return "ACE batch unpaid";
  if (kind.startsWith("outside_due_")) return "Outside-Stripe payment due";
  return kind;
}

export type MessageStatus = "SENT" | "SKIPPED" | "FAILED" | "PENDING";
export type MessageRow = {
  id: string;
  at: Date;
  kind: string;
  kindLabel: string;
  clientId: string | null;
  clientName: string | null;
  to: string | null;
  channels: string;
  status: string;
  why: string | null;
  attempts: number;
};

/** Owners / Super Admin: the latest messages the portal tried to send, and why any weren't sent. */
export async function messageLog(opts: { status?: string; limit?: number } = {}): Promise<{ rows: MessageRow[]; counts: Record<string, number>; total: number }> {
  await requirePermission("audit.view");
  const grouped = await db.notification.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  const where = opts.status ? { status: opts.status } : {};
  const notes = await db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: opts.limit ?? 200 });
  const clients = await db.client.findMany({
    where: { id: { in: [...new Set(notes.flatMap((n) => (n.clientId ? [n.clientId] : [])))] } },
    select: { id: true, name: true, companyName: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.companyName || c.name]));
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    rows: notes.map((n) => ({
      id: n.id,
      at: n.sentAt ?? n.createdAt,
      kind: n.kind,
      kindLabel: messageKindLabel(n.kind),
      clientId: n.clientId,
      clientName: n.clientId ? nameOf.get(n.clientId) ?? null : null,
      to: n.to,
      channels: n.channels,
      status: n.status,
      why: n.error,
      attempts: n.attempts,
    })),
  };
}
