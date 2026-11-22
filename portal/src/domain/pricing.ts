/**
 * Pure: is a client paying less than their package's list price?
 * - "coupon": a Stripe discount is on the subscription (including one given in the portal).
 * - "price": the subscription's own price is below the package list price (a custom price set in Stripe).
 * Six-month-contract prices are their own price list, so they aren't compared with the monthly list price.
 */
export type DiscountState = { discounted: boolean; byCoupon: boolean; byPrice: boolean };

export function discountState(
  r: { packageMonthlyCents: number; hasDiscount: boolean; sixMonthContract: boolean },
  listPriceCents: number | null,
): DiscountState {
  const byCoupon = r.hasDiscount;
  const byPrice = !r.sixMonthContract && listPriceCents !== null && listPriceCents > 0 && r.packageMonthlyCents > 0 && r.packageMonthlyCents < listPriceCents;
  return { discounted: byCoupon || byPrice, byCoupon, byPrice };
}
