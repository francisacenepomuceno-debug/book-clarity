import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/auth/permissions";
import { parsePeriod } from "@/domain/periods";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

export type PaymentStatus = "PAID" | "FAILED" | "PROCESSING" | "OPEN" | "SUSPENDED" | "PREPAID_ACE";
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PAID: "Paid",
  FAILED: "Failed",
  PROCESSING: "Processing (bank)",
  OPEN: "Not yet charged",
  SUSPENDED: "Suspended",
  PREPAID_ACE: "Prepaid by ACE",
};

type Base = { name: string; href: string; type: "DIRECT" | "ACE"; status: PaymentStatus; date: Date | null };
export type PaymentRow = Base & { amountCents?: number; method?: string | null };

function methodLabel(type: string | null, funding: string | null): string | null {
  if (!type) return null;
  if (type === "card") return funding === "credit" ? "Credit card" : funding === "debit" ? "Debit card" : "Card";
  if (type === "us_bank_account") return "ACH";
  return type;
}

/**
 * The Payments view (spec §12): each client's monthly bill for a month and how it went.
 * Roles without payments.viewAmounts never receive amounts or payment methods (stripped here, not in the page).
 */
export async function monthlyPayments(monthKey: string, role: Role) {
  const month = parsePeriod("month", monthKey, TZ);
  const amounts = can(role, "payments.viewAmounts");
  const [invoices, aceClients, slots] = await Promise.all([
    db.invoice.findMany({
      where: { kind: "SUBSCRIPTION", status: { notIn: ["void", "draft"] }, billedAt: { gte: month.start, lt: month.end }, clientId: { not: null } },
      include: { client: true },
      orderBy: { billedAt: "asc" },
    }),
    db.client.findMany({ where: { type: "ACE", acePrepaidUntil: { gte: month.start }, OR: [{ endedAt: null }, { endedAt: { gte: month.start } }] } }),
    db.aceSlot.findMany({ where: { clientId: { not: null } } }),
  ]);
  const slotStart = new Map(slots.map((s) => [s.clientId!, s.startDate]));
  const billed = new Set(invoices.map((i) => i.clientId));
  const rows: PaymentRow[] = [];

  for (const i of invoices) {
    const c = i.client!;
    const status: PaymentStatus =
      i.status === "paid" ? "PAID"
      : i.processingSince ? "PROCESSING"
      : c.suspendedAt && i.firstFailedAt ? "SUSPENDED"
      : i.firstFailedAt || i.status === "uncollectible" ? "FAILED"
      : "OPEN";
    const base: Base = {
      name: c.name,
      href: `/clients/${c.stripeSubscriptionId ?? c.id}`,
      type: c.type,
      status,
      date: status === "PAID" ? i.paidAt : status === "PROCESSING" ? i.processingSince : status === "OPEN" ? i.billedAt : i.firstFailedAt,
    };
    rows.push(amounts ? { ...base, amountCents: i.totalCents, method: methodLabel(i.paymentMethodType, i.cardFunding) } : base);
  }
  for (const c of aceClients) {
    if (billed.has(c.id)) continue;
    const start = slotStart.get(c.id);
    if (start && start >= month.end) continue;
    const base: Base = { name: c.name, href: `/clients/${c.stripeSubscriptionId ?? c.id}`, type: "ACE", status: "PREPAID_ACE", date: c.acePrepaidUntil };
    rows.push(base);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const counts: Partial<Record<PaymentStatus, number>> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return { month, rows, counts };
}
