import { describe, expect, it } from "vitest";
import { validateDiscount } from "@/domain/discount";

const base = { months: 3, reason: "Loyal client", monthlyPriceCents: 65000 };

describe("validateDiscount", () => {
  it("percent → repeating coupon", () => {
    expect(validateDiscount({ ...base, kind: "PERCENT", percentOff: 20 })).toEqual({
      ok: true,
      coupon: { percent_off: 20, duration: "repeating", duration_in_months: 3 },
    });
  });
  it("amount → repeating USD coupon", () => {
    expect(validateDiscount({ ...base, kind: "AMOUNT", amountOffCents: 15000, months: 2 })).toEqual({
      ok: true,
      coupon: { amount_off: 15000, currency: "usd", duration: "repeating", duration_in_months: 2 },
    });
  });
  it("100% is allowed", () => {
    expect(validateDiscount({ ...base, kind: "PERCENT", percentOff: 100 }).ok).toBe(true);
  });
  it.each([
    ["percent 0", { kind: "PERCENT", percentOff: 0 }],
    ["percent over 100", { kind: "PERCENT", percentOff: 101 }],
    ["fractional percent", { kind: "PERCENT", percentOff: 12.5 }],
    ["amount above the monthly price", { kind: "AMOUNT", amountOffCents: 65001 }],
    ["amount 0", { kind: "AMOUNT", amountOffCents: 0 }],
    ["months below 1", { kind: "PERCENT", percentOff: 10, months: 0 }],
    ["more than 36 months", { kind: "PERCENT", percentOff: 10, months: 37 }],
    ["blank reason", { kind: "PERCENT", percentOff: 10, reason: "   " }],
  ])("rejects %s", (_, over) => {
    const r = validateDiscount({ ...base, ...(over as object) } as never);
    expect(r.ok).toBe(false);
  });
});
