import type Stripe from "stripe";

export const CARD_FEE_METADATA_KEY = "bc_card_fee";

/**
 * A line is a card-fee line if the portal added it (metadata) or it is one of the
 * pre-existing "3% Credit Card Fee" subscription items (matched by description).
 */
export function isCardFeeLine(line: Pick<Stripe.InvoiceLineItem, "description" | "metadata">): boolean {
  if (line.metadata?.[CARD_FEE_METADATA_KEY] === "1") return true;
  return /credit card (processing )?fee/i.test(line.description ?? "");
}

/** One-off onboarding fee lines (excluded from commission and package revenue). */
export function isOnboardingLine(line: Pick<Stripe.InvoiceLineItem, "description" | "metadata">): boolean {
  return line.metadata?.kind === "ONBOARDING" || /onboarding/i.test(line.description ?? "");
}

export function subscriptionIdOf(inv: Stripe.Invoice): string | null {
  const legacy = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
  const s = inv.parent?.subscription_details?.subscription;
  if (!s) return null;
  return typeof s === "string" ? s : s.id;
}

export const idOf = (x: string | { id: string } | null | undefined): string | null =>
  !x ? null : typeof x === "string" ? x : x.id;

/** A line's amount after its share of any discount (a 20% coupon also reduces the card-fee line). */
export function netLineAmount(line: Pick<Stripe.InvoiceLineItem, "amount"> & { discount_amounts?: { amount: number }[] | null }): number {
  return line.amount - (line.discount_amounts ?? []).reduce((n, d) => n + d.amount, 0);
}
