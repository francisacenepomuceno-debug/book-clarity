import type Stripe from "stripe";

export const MAX_DISCOUNT_MONTHS = 36;

export type DiscountInput =
  | { kind: "PERCENT"; percentOff: number; months: number; reason: string }
  | { kind: "AMOUNT"; amountOffCents: number; months: number; reason: string };

export type DiscountValidation =
  | { ok: true; coupon: Stripe.CouponCreateParams }
  | { ok: false; error: string };

/** Pure: checks an Owner's discount request and builds the Stripe coupon parameters. */
export function validateDiscount(i: DiscountInput & { monthlyPriceCents: number }): DiscountValidation {
  if (!i.reason?.trim()) return { ok: false, error: "A reason is required." };
  if (!Number.isInteger(i.months) || i.months < 1 || i.months > MAX_DISCOUNT_MONTHS) {
    return { ok: false, error: `Months must be a whole number from 1 to ${MAX_DISCOUNT_MONTHS}.` };
  }
  const duration = { duration: "repeating" as const, duration_in_months: i.months };
  if (i.kind === "PERCENT") {
    if (!Number.isInteger(i.percentOff) || i.percentOff < 1 || i.percentOff > 100) {
      return { ok: false, error: "Percent must be a whole number from 1 to 100." };
    }
    return { ok: true, coupon: { percent_off: i.percentOff, ...duration } };
  }
  if (!Number.isInteger(i.amountOffCents) || i.amountOffCents < 1) return { ok: false, error: "Amount must be more than $0." };
  if (i.amountOffCents > i.monthlyPriceCents) {
    return { ok: false, error: "Amount can't be more than the client's monthly package price." };
  }
  return { ok: true, coupon: { amount_off: i.amountOffCents, currency: "usd", ...duration } };
}
