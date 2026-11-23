import { db } from "@/lib/db";

/** Open bills of clients who pay outside Stripe that are due within 7 days or overdue (portal data only, no Stripe). */
export async function outsideDueCount(now: Date = new Date()): Promise<number> {
  return db.invoice.count({
    where: { kind: "SUBSCRIPTION", status: "open", client: { paysOutsideStripe: true, endedAt: null }, OR: [{ dueAt: { lte: new Date(now.getTime() + 7 * 86400_000) } }, { dueAt: null }] },
  });
}

/** The same bills, for the dashboard's Needs attention list. */
export async function outsideDueInvoices(now: Date = new Date()) {
  return db.invoice.findMany({
    where: { kind: "SUBSCRIPTION", status: "open", client: { paysOutsideStripe: true, endedAt: null }, OR: [{ dueAt: { lte: new Date(now.getTime() + 7 * 86400_000) } }, { dueAt: null }] },
    include: { client: true },
    orderBy: { dueAt: "asc" },
  });
}
