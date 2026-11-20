import { describe, expect, it } from "vitest";
import {
  clawbackLines,
  earnedLines,
  monthOf,
  nextMonth,
  packagePaidCents,
  splitAt,
  validateSplit,
  windowMonthsFor,
} from "@/domain/commission";

describe("packagePaidCents", () => {
  it("excludes card fee and onboarding, never negative", () => {
    expect(packagePaidCents({ amountPaidCents: 82400, cardFeeCents: 2400, onboardingCents: 0 })).toBe(80000);
    expect(packagePaidCents({ amountPaidCents: 132400, cardFeeCents: 2400, onboardingCents: 50000 })).toBe(80000);
    expect(packagePaidCents({ amountPaidCents: 1000, cardFeeCents: 2400, onboardingCents: 0 })).toBe(0);
  });
});

describe("splitAt", () => {
  const v1 = [{ executiveId: "jose", rateBp: 1000, effectiveFrom: new Date("2026-01-01") }];
  const v2 = [
    { executiveId: "jose", rateBp: 500, effectiveFrom: new Date("2026-06-01") },
    { executiveId: "albert", rateBp: 500, effectiveFrom: new Date("2026-06-01") },
  ];
  it("uses the latest version on or before the date", () => {
    expect(splitAt([...v1, ...v2], new Date("2026-05-31"))).toEqual([{ executiveId: "jose", rateBp: 1000 }]);
    expect(splitAt([...v1, ...v2], new Date("2026-06-01"))).toEqual([
      { executiveId: "jose", rateBp: 500 },
      { executiveId: "albert", rateBp: 500 },
    ]);
  });
  it("is empty before any version", () => {
    expect(splitAt(v1, new Date("2025-12-31"))).toEqual([]);
  });
});

describe("earnedLines", () => {
  const jose = [{ executiveId: "jose", rateBp: 1000 }];
  it("earns inside the window", () => {
    expect(earnedLines({ baseCents: 65000, paidIndex: 12, windowMonths: 12, split: jose })).toEqual([
      { executiveId: "jose", rateBp: 1000, amountCents: 6500 },
    ]);
  });
  it("nothing after the window or on a $0 base", () => {
    expect(earnedLines({ baseCents: 65000, paidIndex: 13, windowMonths: 12, split: jose })).toEqual([]);
    expect(earnedLines({ baseCents: 0, paidIndex: 1, windowMonths: 12, split: jose })).toEqual([]);
  });
  it("rounds each share half-up", () => {
    const split = [{ executiveId: "j", rateBp: 500 }, { executiveId: "a", rateBp: 500 }];
    expect(earnedLines({ baseCents: 33333, paidIndex: 1, windowMonths: 12, split }).map((l) => l.amountCents)).toEqual([1667, 1667]);
  });
});

describe("clawbackLines", () => {
  const originals = [{ executiveId: "jose", rateBp: 1000, amountCents: 8000 }];
  it("claws back proportionally", () => {
    expect(clawbackLines({ originals, refundPackageCents: 40000, invoicePackageCents: 80000, alreadyClawedByExec: {} })).toEqual([
      { executiveId: "jose", rateBp: 1000, amountCents: -4000 },
    ]);
  });
  it("never claws back more than was earned", () => {
    expect(clawbackLines({ originals, refundPackageCents: 80000, invoicePackageCents: 80000, alreadyClawedByExec: { jose: 6000 } })).toEqual([
      { executiveId: "jose", rateBp: 1000, amountCents: -2000 },
    ]);
    expect(clawbackLines({ originals, refundPackageCents: 80000, invoicePackageCents: 80000, alreadyClawedByExec: { jose: 8000 } })).toEqual([]);
  });
  it("nothing when the invoice had no package amount", () => {
    expect(clawbackLines({ originals, refundPackageCents: 100, invoicePackageCents: 0, alreadyClawedByExec: {} })).toEqual([]);
  });
});

describe("months", () => {
  it("uses the business timezone", () => {
    expect(monthOf(new Date("2026-12-01T03:00:00Z"), "America/New_York")).toBe("2026-11");
    expect(monthOf(new Date("2026-12-01T06:00:00Z"), "America/New_York")).toBe("2026-12");
  });
  it("nextMonth rolls the year", () => {
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(nextMonth("2026-03")).toBe("2026-04");
  });
});

describe("validateSplit", () => {
  it.each([
    [[], false],
    [[{ executiveId: "j", rateBp: 2000 }, { executiveId: "a", rateBp: 1500 }], false],
    [[{ executiveId: "j", rateBp: 600 }, { executiveId: "a", rateBp: 500 }], true],
    [[{ executiveId: "j", rateBp: 500 }, { executiveId: "j", rateBp: 500 }], false],
    [[{ executiveId: "j", rateBp: 0 }], false],
    [[{ executiveId: "j", rateBp: 3001 }], false],
    [[{ executiveId: "j", rateBp: 700 }, { executiveId: "a", rateBp: 300 }], true],
    [[{ executiveId: "j", rateBp: 1000 }], true],
  ])("%j → %s", (shares, ok) => {
    expect(validateSplit(shares).ok).toBe(ok);
  });
});

describe("windowMonthsFor", () => {
  it("Direct 12, ACE (continuing) 6", () => {
    expect(windowMonthsFor({ type: "DIRECT" })).toBe(12);
    expect(windowMonthsFor({ type: "ACE" })).toBe(6);
  });
});
