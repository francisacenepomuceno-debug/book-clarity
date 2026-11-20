import { describe, expect, it } from "vitest";
import { formatUsd, percentOfCents } from "@/lib/money";

describe("money", () => {
  it("percentOfCents rounds half-up to the cent", () => {
    expect(percentOfCents(80000, 300)).toBe(2400); // $800 × 3% = $24.00
    expect(percentOfCents(33333, 300)).toBe(1000); // 999.99 → 1000
    expect(percentOfCents(0, 300)).toBe(0);
  });
  it("formatUsd", () => {
    expect(formatUsd(123456)).toBe("$1,234.56");
  });
});
