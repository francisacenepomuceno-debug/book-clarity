import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/auth/permissions";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import type { ClientStatus } from "@/domain/clientStatus";

type Base = Pick<LiveClientRow, "subscriptionId" | "name" | "status" | "packageName" | "sixMonthContract" | "nextChargeDate" | "pastDueSince">;
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
 * Read-only bridge until the Plan 6 import: make sure every live Stripe customer has a portal Client row,
 * so webhooks and discounts can find it. Only Stripe-owned fields are written; Direct/ACE etc. are left alone.
 */
export async function syncClientsFromSnapshot(rows: LiveClientRow[]): Promise<void> {
  const byCustomer = new Map<string, LiveClientRow>();
  for (const r of rows) {
    const cur = byCustomer.get(r.customerId);
    if (!cur || URGENCY.indexOf(r.status) < URGENCY.indexOf(cur.status)) byCustomer.set(r.customerId, r);
  }
  for (const r of byCustomer.values()) {
    const fields = {
      name: r.name,
      email: r.email,
      stripeSubscriptionId: r.subscriptionId,
      status: r.status,
      // Only "paused" matters for status; webhooks store Stripe's exact value.
      subscriptionStatus: r.status === "PAUSED" ? "paused" : "active",
    };
    await db.client.upsert({
      where: { stripeCustomerId: r.customerId },
      create: { ...fields, stripeCustomerId: r.customerId },
      update: fields,
    });
  }
}
