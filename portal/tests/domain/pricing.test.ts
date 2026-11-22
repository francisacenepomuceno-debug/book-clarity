import { describe, expect, it } from "vitest";
import { discountState } from "@/domain/pricing";

const row = (cents: number, hasDiscount = false, sixMonthContract = false) => ({ packageMonthlyCents: cents, hasDiscount, sixMonthContract });

describe("discountState", () => {
  it("a custom price below the list price is discounted", () => {
    expect(discountState(row(50000), 65000)).toEqual({ discounted: true, byCoupon: false, byPrice: true });
  });
  it("the list price, or more, isn't", () => {
    expect(discountState(row(65000), 65000).discounted).toBe(false);
    expect(discountState(row(95000), 65000).discounted).toBe(false);
  });
  it("a Stripe discount always counts", () => {
    expect(discountState(row(65000, true), 65000)).toEqual({ discounted: true, byCoupon: true, byPrice: false });
    expect(discountState(row(65000, true), null).discounted).toBe(true);
  });
  it("no package, a Custom package, or a 6-month contract price isn't compared", () => {
    expect(discountState(row(50000), null).discounted).toBe(false);
    expect(discountState(row(50000, false, true), 65000).discounted).toBe(false);
  });
});
