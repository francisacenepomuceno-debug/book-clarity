import type Stripe from "stripe";
import { CARD_FEE_DESCRIPTION, decideCardFee } from "@/domain/cardFee";
import { getFeeSettings } from "@/settings/cardFee";
import { writeAudit } from "@/audit/log";
import { CARD_FEE_METADATA_KEY, idOf, isCardFeeLine, subscriptionIdOf } from "@/stripe/lines";
import type { PaidMethod } from "@/stripe/handlers/invoice";

const SUBSCRIPTION_REASONS = new Set(["subscription_cycle", "subscription_create"]);
const REFUND_METADATA_KEY = "bc_card_fee_refund";

type PmLike = { type?: string; card?: { funding?: string } | null } | null;

async function defaultPaymentMethod(inv: Stripe.Invoice, stripe: Stripe): Promise<{ pm: PmLike; state: string | null }> {
  const subId = subscriptionIdOf(inv);
  const sub = subId ? await stripe.subscriptions.retrieve(subId, { expand: ["default_payment_method"] }) : null;
  const customer = (await stripe.customers.retrieve(idOf(inv.customer as string)!, {
    expand: ["invoice_settings.default_payment_method"],
  })) as Stripe.Customer;
  const pm = (sub?.default_payment_method ?? customer.invoice_settings?.default_payment_method ?? null) as PmLike;
  return { pm: typeof pm === "object" ? pm : null, state: customer.address?.state ?? null };
}

/**
 * On invoice.created (draft, ~1 hour before finalising): add the 3% line for credit cards.
 * Skips invoices that already carry any card-fee line, including legacy "3% Credit Card Fee" subscription items.
 */
export async function applyCardFeeToDraft(
  inv: Stripe.Invoice,
  stripe: Stripe,
): Promise<"added" | "skipped_not_draft" | "skipped_exists" | "skipped_rule"> {
  if (inv.status !== "draft") return "skipped_not_draft";
  if ((inv.lines?.data ?? []).some(isCardFeeLine)) return "skipped_exists";
  if (!SUBSCRIPTION_REASONS.has(inv.billing_reason ?? "")) return "skipped_rule";

  const settings = await getFeeSettings();
  if (!settings.enabled) return "skipped_rule";

  const { pm, state } = await defaultPaymentMethod(inv, stripe);
  const discounts = (inv.total_discount_amounts ?? []).reduce((n, d) => n + d.amount, 0);
  const decision = decideCardFee({
    baseCents: inv.subtotal - discounts,
    paymentMethodType: pm?.type ?? null,
    cardFunding: pm?.type === "card" ? ((pm.card?.funding ?? "unknown") as "credit") : null,
    billingState: state,
    settings,
  });
  if (decision.feeCents === 0) return "skipped_rule";

  await stripe.invoiceItems.create({
    customer: idOf(inv.customer as string)!,
    invoice: inv.id!,
    amount: decision.feeCents,
    currency: inv.currency ?? "usd",
    description: CARD_FEE_DESCRIPTION,
    discountable: false,
    metadata: { [CARD_FEE_METADATA_KEY]: "1" },
  });
  await writeAudit({
    actorId: null,
    action: "card_fee_added",
    entity: "Invoice",
    entityId: inv.id!,
    after: { feeCents: decision.feeCents, baseCents: inv.subtotal - discounts },
  });
  return "added";
}

/**
 * On invoice.paid: refund a portal-added fee if the invoice was not paid by a credit card;
 * log when a credit card paid a subscription invoice that carried no fee.
 */
export async function reconcileCardFee(
  inv: Stripe.Invoice,
  paid: PaidMethod | null,
  stripe: Stripe,
): Promise<"refunded" | "logged_uncollected" | "ok"> {
  if (!paid?.chargeId) return "ok";
  const lines = inv.lines?.data ?? [];
  const portalFee = lines.filter((l) => l.metadata?.[CARD_FEE_METADATA_KEY] === "1").reduce((n, l) => n + l.amount, 0);
  const anyFee = lines.some(isCardFeeLine);
  const paidByCredit = paid.type === "card" && paid.funding === "credit";

  if (portalFee > 0 && !paidByCredit) {
    const existing = await stripe.refunds.list({ charge: paid.chargeId, limit: 100 });
    if (existing.data.some((r) => r.metadata?.[REFUND_METADATA_KEY] === "1" && r.metadata?.invoice === inv.id)) return "ok";
    await stripe.refunds.create({
      charge: paid.chargeId,
      amount: portalFee,
      metadata: { [REFUND_METADATA_KEY]: "1", invoice: inv.id! },
    });
    await writeAudit({ actorId: null, action: "card_fee_refunded", entity: "Invoice", entityId: inv.id!, after: { feeCents: portalFee, paidWith: paid.type, funding: paid.funding } });
    return "refunded";
  }

  if (!anyFee && paidByCredit && subscriptionIdOf(inv)) {
    await writeAudit({ actorId: null, action: "card_fee_uncollected", entity: "Invoice", entityId: inv.id!, after: { totalCents: inv.total } });
    return "logged_uncollected";
  }
  return "ok";
}
