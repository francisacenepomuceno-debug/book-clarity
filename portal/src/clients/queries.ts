import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/auth/permissions";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import type { ClientStatus } from "@/domain/clientStatus";

type Base = Pick<LiveClientRow, "subscriptionId" | "name" | "status" | "packageName" | "sixMonthContract" | "nextChargeDate" | "pastDueSince"> & { clientType: "DIRECT" | "ACE" };
type Financial = Pick<
  LiveClientRow,
  "customerId" | "email" | "packageMonthlyCents" | "cardFeeMonthlyCents" | "hasDiscount" | "autopay" | "paymentMethod" | "amountDueCents"
>;
export type ClientRow = Base & Partial<Financial>;

/** Field-level scoping at the data layer: roles without clients.viewFinancials never receive money or contact fields. */
export function scopeRow(r: LiveClientRow, role: Role): ClientRow {
  const base: Base = {
    subscriptionId: r.subscriptionId,
    name: r.name,
    status: r.status,
    packageName: r.packageName,
    sixMonthContract: r.sixMonthContract,
    nextChargeDate: r.nextChargeDate,
    pastDueSince: r.pastDueSince,
    clientType: r.clientType ?? "DIRECT",
  };
  if (!can(role, "clients.viewFinancials")) return base;
  return {
    ...base,
    customerId: r.customerId,
    email: r.email,
    packageMonthlyCents: r.packageMonthlyCents,
    cardFeeMonthlyCents: r.cardFeeMonthlyCents,
    hasDiscount: r.hasDiscount,
    autopay: r.autopay,
    paymentMethod: r.paymentMethod,
    amountDueCents: r.amountDueCents,
  };
}

const URGENCY: ClientStatus[] = ["AT_RISK", "PAST_DUE", "UNPAID", "CURRENT", "CONTINUING_AWAITING_PM", "PREPAID_ACE", "ONBOARDING", "PAUSED", "ENDED"];

/**
 * Read-only bridge until the Plan 6 import: make sure every live Stripe customer has a portal Client row (create-only),
 * so webhooks and discounts can find it. Only Stripe-owned fields are written; Direct/ACE etc. are left alone.
 */
export async function syncClientsFromSnapshot(rows: LiveClientRow[]): Promise<void> {
  const byCustomer = new Map<string, LiveClientRow>();
  for (const r of rows) {
    const cur = byCustomer.get(r.customerId);
    if (!cur || URGENCY.indexOf(r.status) < URGENCY.indexOf(cur.status)) byCustomer.set(r.customerId, r);
  }
  for (const r of byCustomer.values()) {
    // Create missing clients only. Status, subscription link and Stripe status belong to the webhooks;
    // only contact details are refreshed here.
    await db.client.upsert({
      where: { stripeCustomerId: r.customerId },
      create: {
        stripeCustomerId: r.customerId,
        stripeSubscriptionId: r.subscriptionId,
        name: r.name,
        email: r.email,
        status: r.status,
        subscriptionStatus: r.status === "PAUSED" ? "paused" : null,
      },
      update: { name: r.name, email: r.email },
    });
  }
}

/** Adds Direct/ACE from the portal's client records to live Stripe rows. */
export async function withClientTypes(rows: LiveClientRow[]): Promise<LiveClientRow[]> {
  const aces = await db.client.findMany({
    where: { type: "ACE", stripeSubscriptionId: { in: rows.map((r) => r.subscriptionId) } },
    select: { stripeSubscriptionId: true },
  });
  const ace = new Set(aces.map((a) => a.stripeSubscriptionId));
  return rows.map((r) => ({ ...r, clientType: ace.has(r.subscriptionId) ? "ACE" : "DIRECT" }));
}

/**
 * ACE clients who aren't on a Stripe subscription yet (prepaid, or waiting to continue), as dashboard rows.
 * Their row id is the portal client id, which the client page also accepts.
 */
export async function aceDashboardRows(): Promise<LiveClientRow[]> {
  const clients = await db.client.findMany({
    where: { type: "ACE", stripeSubscriptionId: null, status: { not: "ENDED" } },
    orderBy: { name: "asc" },
  });
  const packages = await db.package.findMany({ where: { id: { in: clients.flatMap((c) => (c.packageId ? [c.packageId] : [])) } } });
  const name = new Map(packages.map((p) => [p.id, p.name]));
  return clients.map((c) => ({
    clientType: "ACE" as const,
    customerId: c.stripeCustomerId ?? "",
    subscriptionId: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    packageName: c.packageId ? name.get(c.packageId) ?? "—" : "—",
    sixMonthContract: false,
    packageMonthlyCents: 0,
    cardFeeMonthlyCents: 0,
    hasDiscount: false,
    autopay: false,
    paymentMethod: "Prepaid by ACE",
    nextChargeDate: null,
    amountDueCents: 0,
    pastDueSince: null,
  }));
}
