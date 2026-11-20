import { describe, expect, it } from "vitest";
import { decideCardFee, type FeeSettings } from "@/domain/cardFee";

const s: FeeSettings = { enabled: true, rateBasisPoints: 300, excludedStates: ["CT"] };
const credit = { baseCents: 80000, paymentMethodType: "card" as const, cardFunding: "credit" as const, billingState: "TX", settings: s };

describe("decideCardFee", () => {
  it("charges 3% on a credit card", () => {
    expect(decideCardFee(credit)).toEqual({ feeCents: 2400, reason: "credit_card" });
  });
  it.each(["debit", "prepaid", "unknown"] as const)("never charges a %s card", (cardFunding) => {
    expect(decideCardFee({ ...credit, cardFunding })).toEqual({ feeCents: 0, reason: "not_credit" });
  });
  it("never charges ACH", () => {
    expect(decideCardFee({ ...credit, paymentMethodType: "us_bank_account", cardFunding: null })).toEqual({ feeCents: 0, reason: "not_credit" });
  });
  it("no payment method → no fee", () => {
    expect(decideCardFee({ ...credit, paymentMethodType: null, cardFunding: null })).toEqual({ feeCents: 0, reason: "no_method" });
  });
  it("card with unknown funding (null) → no fee", () => {
    expect(decideCardFee({ ...credit, cardFunding: null })).toEqual({ feeCents: 0, reason: "not_credit" });
  });
  it("excluded state → no fee, case-insensitive", () => {
    expect(decideCardFee({ ...credit, billingState: "ct" })).toEqual({ feeCents: 0, reason: "state_excluded" });
  });
  it("disabled → no fee", () => {
    expect(decideCardFee({ ...credit, settings: { ...s, enabled: false } })).toEqual({ feeCents: 0, reason: "disabled" });
  });
  it("rate above the 3% cap throws", () => {
    expect(() => decideCardFee({ ...credit, settings: { ...s, rateBasisPoints: 450 } })).toThrow(RangeError);
  });
  it("zero or negative base → no fee", () => {
    expect(decideCardFee({ ...credit, baseCents: 0 }).feeCents).toBe(0);
    expect(decideCardFee({ ...credit, baseCents: -500 }).feeCents).toBe(0);
  });
});
