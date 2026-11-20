import { describe, expect, it } from "vitest";
import { aceLumpBase, batchTotals, continuationDueAt, prepaidUntil } from "@/domain/ace";

const NY = "America/New_York";

describe("prepaidUntil", () => {
  it("ends the day before the same date 6 months later (end of day, business timezone)", () => {
    expect(prepaidUntil("2026-01-15", NY).toISOString()).toBe("2026-07-15T03:59:59.999Z");
  });
  it("handles the 31st", () => {
    expect(prepaidUntil("2026-01-31", NY).toISOString()).toBe("2026-07-31T03:59:59.999Z"); // end of Jul 30 NY
  });
  it("clamps to the last day of a short month", () => {
    expect(prepaidUntil("2026-08-31", NY).toISOString()).toBe("2027-02-28T04:59:59.999Z"); // end of Feb 27 NY
  });
});

describe("continuationDueAt", () => {
  it("is 30 days before the end", () => {
    const end = prepaidUntil("2026-01-15", NY);
    expect(end.getTime() - continuationDueAt(end).getTime()).toBe(30 * 24 * 3600_000);
  });
});

describe("money", () => {
  it("batch total and ACE lump base", () => {
    expect(batchTotals([{ quantity: 10, unitPriceCents: 260000 }, { quantity: 1, unitPriceCents: 500000 }])).toBe(3100000);
    expect(aceLumpBase({ monthlyListCents: 65000 })).toBe(390000);
  });
});
