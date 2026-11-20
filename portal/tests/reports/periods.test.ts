import { describe, expect, it } from "vitest";
import { bucketsBetween, change, parsePeriod, periodOf, previous } from "@/domain/periods";

const TZ = "America/New_York";
const iso = (d: Date) => d.toISOString();

describe("periods", () => {
  it("a payment at 11:30 pm New York time on Nov 30 is in November", () => {
    const pay = new Date("2026-12-01T04:30:00Z"); // 11:30 pm EST on Nov 30
    const p = periodOf("month", pay, TZ);
    expect(p.key).toBe("2026-11");
    expect(iso(p.start)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(p.end)).toBe("2026-12-01T05:00:00.000Z");
    expect(pay >= p.start && pay < p.end).toBe(true);
    expect(p.label).toBe("November 2026");
  });

  it("weeks start on Monday (ISO weeks)", () => {
    const p = periodOf("week", new Date("2026-11-20T15:00:00Z"), TZ); // Friday
    expect(p.key).toBe("2026-W47");
    expect(iso(p.start)).toBe("2026-11-16T05:00:00.000Z");
    expect(iso(p.end)).toBe("2026-11-23T05:00:00.000Z");
    expect(p.label).toBe("Week of Nov 16, 2026");
    // Sunday 11 pm local is still the same week
    expect(periodOf("week", new Date("2026-11-23T04:00:00Z"), TZ).key).toBe("2026-W47");
  });

  it("previous period across year boundaries", () => {
    expect(previous(parsePeriod("month", "2026-01", TZ)).key).toBe("2025-12");
    expect(previous(parsePeriod("year", "2026", TZ)).key).toBe("2025");
    expect(previous(parsePeriod("week", "2026-W01", TZ)).key).toBe("2025-W52");
    expect(previous(parsePeriod("week", "2027-W01", TZ)).key).toBe("2026-W53");
  });

  it("parses keys and handles DST", () => {
    const march = parsePeriod("month", "2026-03", TZ);
    expect(iso(march.start)).toBe("2026-03-01T05:00:00.000Z");
    expect(iso(march.end)).toBe("2026-04-01T04:00:00.000Z");
    const y = parsePeriod("year", "2026", TZ);
    expect(iso(y.start)).toBe("2026-01-01T05:00:00.000Z");
    expect(iso(y.end)).toBe("2027-01-01T05:00:00.000Z");
    expect(parsePeriod("week", "2026-W47", TZ).key).toBe("2026-W47");
    expect(() => parsePeriod("month", "2026-13", TZ)).toThrow();
  });

  it("lists buckets for trends", () => {
    const end = parsePeriod("month", "2026-11", TZ);
    expect(bucketsBetween(end, 3).map((b) => b.key)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("change: delta and percent, null percent when the previous value is 0", () => {
    expect(change(150, 100)).toEqual({ delta: 50, pct: 50 });
    expect(change(5, 0)).toEqual({ delta: 5, pct: null });
    expect(change(0, 0)).toEqual({ delta: 0, pct: null });
  });
});
