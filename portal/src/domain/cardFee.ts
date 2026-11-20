import { percentOfCents } from "@/lib/money";

export const MAX_CARD_FEE_BASIS_POINTS = 300; // 3% legal/network cap (spec §7.3)
export const CARD_FEE_DESCRIPTION = "Credit card processing fee (3%)";

export type FeeSettings = { enabled: boolean; rateBasisPoints: number; excludedStates: string[] };
export const DEFAULT_FEE_SETTINGS: FeeSettings = { enabled: false, rateBasisPoints: 300, excludedStates: [] };

export type FeeDecision = {
  feeCents: number;
  reason: "credit_card" | "not_credit" | "no_method" | "state_excluded" | "disabled";
};

/** Pure rule: 3% only on credit cards. Never debit, prepaid, unknown-funding cards or ACH. */
export function decideCardFee(i: {
  baseCents: number;
  paymentMethodType: "card" | "us_bank_account" | null;
  cardFunding: "credit" | "debit" | "prepaid" | "unknown" | null;
  billingState: string | null;
  settings: FeeSettings;
}): FeeDecision {
  if (i.settings.rateBasisPoints > MAX_CARD_FEE_BASIS_POINTS || i.settings.rateBasisPoints < 0) {
    throw new RangeError(`Card fee rate ${i.settings.rateBasisPoints}bp is outside 0–${MAX_CARD_FEE_BASIS_POINTS}bp`);
  }
  if (!i.settings.enabled) return { feeCents: 0, reason: "disabled" };
  if (i.paymentMethodType === null) return { feeCents: 0, reason: "no_method" };
  if (i.paymentMethodType !== "card" || i.cardFunding !== "credit") return { feeCents: 0, reason: "not_credit" };
  const state = i.billingState?.trim().toUpperCase();
  if (state && i.settings.excludedStates.some((s) => s.toUpperCase() === state)) {
    return { feeCents: 0, reason: "state_excluded" };
  }
  return { feeCents: Math.max(0, percentOfCents(Math.max(0, i.baseCents), i.settings.rateBasisPoints)), reason: "credit_card" };
}
