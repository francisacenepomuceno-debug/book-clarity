import type Stripe from "stripe";
import { deriveClientStatus, type ClientStatus } from "@/domain/clientStatus";
import { classifyProduct } from "@/stripe/catalog";

export type LiveClientRow = {
  clientType?: "DIRECT" | "ACE";
  customerId: string;
  subscriptionId: string;
  name: string;
  email: string | null;
  phone?: string | null;
  status: ClientStatus;
  packageName: string;
  sixMonthContract: boolean;
  packageMonthlyCents: number;
  cardFeeMonthlyCents: number;
  hasDiscount: boolean;
  autopay: boolean;
  paymentMethod: string;
  nextChargeDate: Date | null;
  amountDueCents: number;
  pastDueSince: Date | null;
  /** Each subscription item's price and product name (for linking to a portal package). */
  priceItems?: { priceId: string; productName: string }[];
};

const fromTs = (t: number | null | undefined) => (t ? new Date(t * 1000) : null);

function idOf(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === "string" ? x : x.id;
}

function paymentMethodLabel(pm: unknown): string {
  if (!pm || typeof pm === "string") return pm ? "On file" : "None on file";
  const p = pm as { type?: string; object?: string; funding?: string; card?: { funding?: string } };
  // Legacy Source/Card objects carry funding at the top level.
  const type = p.type ?? (p.object === "card" ? "card" : undefined);
  if (type === "card") {
    const f = p.card?.funding ?? p.funding;
    return f === "credit" ? "Credit card" : f === "debit" ? "Debit card" : f === "prepaid" ? "Prepaid card" : "Card";
  }
  if (type === "us_bank_account" || p.object === "bank_account") return "ACH";
  if (type === "link") return "Link";
  return type ?? "Other";
}

/** Pure mapping of an expanded Stripe subscription to a dashboard row. */
export function mapSubscription(
  sub: Stripe.Subscription,
  productNames: Map<string, string>,
  now: Date,
): LiveClientRow {
  const customer = (typeof sub.customer === "object" ? sub.customer : null) as Stripe.Customer | null;

  let packageCents = 0;
  let feeCents = 0;
  const packages: string[] = [];
  const priceItems: { priceId: string; productName: string }[] = [];
  let sixMonth = false;
  let nextCharge: number | null = null;

  for (const item of sub.items.data) {
    const productId = idOf(item.price.product as string | { id: string }) ?? "";
    const cls = classifyProduct(productNames.get(productId) ?? productId);
    priceItems.push({ priceId: item.price.id, productName: productNames.get(productId) ?? productId });
    const cents = (item.price.unit_amount ?? 0) * (item.quantity ?? 1);
    if (cls.kind === "card_fee") feeCents += cents;
    else if (cls.kind === "onboarding") {
      /* one-off fees are not recurring package revenue */
    } else {
      packageCents += cents;
      packages.push(cls.kind === "package" ? cls.package : `Other: ${cls.name}`);
      if (cls.kind === "package" && cls.sixMonth) sixMonth = true;
    }
    const end = (item as { current_period_end?: number }).current_period_end;
    if (end && (nextCharge === null || end < nextCharge)) nextCharge = end;
  }

  const inv = (typeof sub.latest_invoice === "object" ? sub.latest_invoice : null) as Stripe.Invoice | null;
  const invOpen = inv?.status === "open" || inv?.status === "uncollectible";
  const failed =
    invOpen && ((inv.attempt_count ?? 0) > 0 || sub.status === "past_due" || sub.status === "unpaid");
  const failedAt = failed
    ? fromTs(inv!.due_date) ?? fromTs(inv!.status_transitions?.finalized_at) ?? fromTs(inv!.created)
    : null;

  const ended = sub.status === "canceled" || sub.status === "incomplete_expired";
  const paused = sub.status === "paused";
  const suspended = sub.metadata?.bc_suspended === "1";

  const status = deriveClientStatus({
    type: "DIRECT", // Direct vs ACE comes from the commission spreadsheet import (Plan 6)
    endedAt: ended ? fromTs(sub.ended_at) ?? now : null,
    paused,
    suspended,
    onboardingComplete: true,
    acePrepaidUntil: null,
    continuingAwaitingPm: false,
    latestInvoice: inv ? { status: inv.status as "open", firstFailedAt: failedAt } : null,
    now,
  });

  const pm = sub.default_payment_method ?? customer?.invoice_settings?.default_payment_method ?? customer?.default_source ?? null;
  const autopay = sub.collection_method !== "send_invoice";
  const pmLabel = paymentMethodLabel(pm);
  const paymentMethod = autopay ? pmLabel : pm ? `Emailed invoice (${pmLabel} on file)` : "Emailed invoice";

  return {
    customerId: customer?.id ?? idOf(sub.customer as string) ?? "",
    subscriptionId: sub.id,
    name: customer?.name || customer?.email || "(no name)",
    email: customer?.email ?? null,
    phone: customer?.phone ?? null,
    status,
    packageName: [...new Set(packages)].join(" + ") || "—",
    sixMonthContract: sixMonth,
    packageMonthlyCents: packageCents,
    cardFeeMonthlyCents: feeCents,
    hasDiscount: (sub.discounts?.length ?? 0) > 0,
    autopay,
    paymentMethod,
    nextChargeDate: ended || paused ? null : fromTs(nextCharge),
    amountDueCents: invOpen ? inv!.amount_remaining ?? 0 : 0,
    pastDueSince: failedAt,
    priceItems,
  };
}
