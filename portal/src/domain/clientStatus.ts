export type ClientType = "DIRECT" | "ACE";

export type ClientStatus =
  | "ONBOARDING"
  | "PREPAID_ACE"
  | "CURRENT"
  | "UNPAID"
  | "PAST_DUE"
  | "AT_RISK"
  | "PAUSED"
  | "CONTINUING_AWAITING_PM"
  | "ENDED";

export type StatusInput = {
  type: ClientType;
  endedAt: Date | null;
  paused: boolean;
  onboardingComplete: boolean;
  acePrepaidUntil: Date | null;
  continuingAwaitingPm: boolean;
  latestInvoice: {
    status: "draft" | "open" | "paid" | "uncollectible" | "void";
    firstFailedAt: Date | null;
  } | null;
  now: Date;
};

export const AT_RISK_DAYS = 21;
const DAY_MS = 24 * 3600_000;

/** Precedence follows spec §6 / Plan 1 Task 3. Pure: no I/O. */
export function deriveClientStatus(i: StatusInput): ClientStatus {
  if (i.endedAt) return "ENDED";
  if (!i.onboardingComplete) return "ONBOARDING";
  if (i.acePrepaidUntil && i.acePrepaidUntil > i.now) return "PREPAID_ACE";
  if (i.paused) return "PAUSED";
  if (i.continuingAwaitingPm) return "CONTINUING_AWAITING_PM";
  const inv = i.latestInvoice;
  if (inv?.status === "open" || inv?.status === "uncollectible") {
    if (inv.firstFailedAt) {
      const days = (i.now.getTime() - inv.firstFailedAt.getTime()) / DAY_MS;
      return days >= AT_RISK_DAYS ? "AT_RISK" : "PAST_DUE";
    }
    return "UNPAID";
  }
  return "CURRENT";
}

export const STATUS_LABEL: Record<ClientStatus, string> = {
  ONBOARDING: "Onboarding",
  PREPAID_ACE: "Prepaid by ACE",
  CURRENT: "Current",
  UNPAID: "Unpaid this month",
  PAST_DUE: "Past due",
  AT_RISK: "At risk",
  PAUSED: "Paused",
  CONTINUING_AWAITING_PM: "Continuing: awaiting payment method",
  ENDED: "Ended",
};
