import { describe, expect, it } from "vitest";
import { deriveClientStatus, type StatusInput } from "@/domain/clientStatus";

const now = new Date("2026-11-20T12:00:00Z");
const daysAgo = (d: number, h = 0) => new Date(now.getTime() - (d * 24 + h) * 3600_000);

const base: StatusInput = {
  type: "DIRECT",
  endedAt: null,
  paused: false,
  onboardingComplete: true,
  acePrepaidUntil: null,
  continuingAwaitingPm: false,
  latestInvoice: null,
  now,
};

describe("deriveClientStatus", () => {
  it("ended wins over everything", () => {
    expect(deriveClientStatus({ ...base, endedAt: daysAgo(1), paused: true })).toBe("ENDED");
  });
  it("onboarding before billing states", () => {
    expect(deriveClientStatus({ ...base, onboardingComplete: false })).toBe("ONBOARDING");
  });
  it("ACE prepaid is never past due", () => {
    expect(
      deriveClientStatus({
        ...base,
        type: "ACE",
        acePrepaidUntil: new Date("2027-01-01"),
        latestInvoice: { status: "open", firstFailedAt: daysAgo(30) },
      }),
    ).toBe("PREPAID_ACE");
  });
  it("paused", () => {
    expect(deriveClientStatus({ ...base, paused: true })).toBe("PAUSED");
  });
  it("continuing awaiting payment method", () => {
    expect(deriveClientStatus({ ...base, continuingAwaitingPm: true })).toBe("CONTINUING_AWAITING_PM");
  });
  it("at risk at exactly 21 days", () => {
    expect(deriveClientStatus({ ...base, latestInvoice: { status: "open", firstFailedAt: daysAgo(21) } })).toBe("AT_RISK");
  });
  it("past due just under 21 days", () => {
    expect(deriveClientStatus({ ...base, latestInvoice: { status: "open", firstFailedAt: daysAgo(20, 23) } })).toBe("PAST_DUE");
  });
  it("unpaid when open without failure", () => {
    expect(deriveClientStatus({ ...base, latestInvoice: { status: "open", firstFailedAt: null } })).toBe("UNPAID");
  });
  it("current when paid or no invoice", () => {
    expect(deriveClientStatus({ ...base, latestInvoice: { status: "paid", firstFailedAt: null } })).toBe("CURRENT");
    expect(deriveClientStatus(base)).toBe("CURRENT");
  });
});
