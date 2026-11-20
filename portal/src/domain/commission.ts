import { percentOfCents } from "@/lib/money";

export const DEFAULT_RATE_BP = 1000; // 10%
export const MAX_RATE_BP = 1000;

export type Share = { executiveId: string; rateBp: number; effectiveFrom: Date };
export type SplitLine = { executiveId: string; rateBp: number };
export type AmountLine = SplitLine & { amountCents: number };

/** Package amount actually paid on an invoice: excludes the 3% card fee and onboarding fees (spec §9). */
export function packagePaidCents(i: { amountPaidCents: number; cardFeeCents: number; onboardingCents: number }): number {
  return Math.max(0, i.amountPaidCents - i.cardFeeCents - i.onboardingCents);
}

/** The split version in force at `at`: all shares with the latest effectiveFrom ≤ at. */
export function splitAt(shares: Share[], at: Date): SplitLine[] {
  const eligible = shares.filter((s) => s.effectiveFrom.getTime() <= at.getTime());
  if (eligible.length === 0) return [];
  const latest = Math.max(...eligible.map((s) => s.effectiveFrom.getTime()));
  return eligible.filter((s) => s.effectiveFrom.getTime() === latest).map(({ executiveId, rateBp }) => ({ executiveId, rateBp }));
}

/** Paid months that earn commission: Direct 12; an ACE client who continues earns 6 more (months 7–12). */
export function windowMonthsFor(client: { type: "DIRECT" | "ACE" }): number {
  return client.type === "ACE" ? 6 : 12;
}

/** Commission on one cleared payment. paidIndex is 1-based among paid months with a package amount. */
export function earnedLines(i: { baseCents: number; paidIndex: number; windowMonths: number; split: SplitLine[] }): AmountLine[] {
  if (i.baseCents <= 0 || i.paidIndex < 1 || i.paidIndex > i.windowMonths) return [];
  return i.split.map((s) => ({ ...s, amountCents: percentOfCents(i.baseCents, s.rateBp) }));
}

/** Negative lines for a refund, proportional to the refunded package share, never exceeding what was earned. */
export function clawbackLines(i: {
  originals: AmountLine[];
  refundPackageCents: number;
  invoicePackageCents: number;
  alreadyClawedByExec: Record<string, number>;
}): AmountLine[] {
  if (i.invoicePackageCents <= 0 || i.refundPackageCents <= 0) return [];
  const out: AmountLine[] = [];
  for (const o of i.originals) {
    const share = Math.floor((o.amountCents * i.refundPackageCents * 2 + i.invoicePackageCents) / (2 * i.invoicePackageCents));
    const room = o.amountCents - (i.alreadyClawedByExec[o.executiveId] ?? 0);
    const amount = Math.min(share, room);
    if (amount > 0) out.push({ executiveId: o.executiveId, rateBp: o.rateBp, amountCents: -amount });
  }
  return out;
}

/** "YYYY-MM" of a moment in the business timezone. */
export function monthOf(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

export function nextMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

export function validateSplit(shares: SplitLine[]): { ok: true } | { ok: false; error: string } {
  if (shares.length === 0) return { ok: false, error: "Pick at least one executive." };
  if (new Set(shares.map((s) => s.executiveId)).size !== shares.length) return { ok: false, error: "Each executive can appear only once." };
  if (shares.some((s) => !Number.isInteger(s.rateBp) || s.rateBp <= 0 || s.rateBp > MAX_RATE_BP)) {
    return { ok: false, error: "Each share must be more than 0% and at most 10%." };
  }
  if (shares.reduce((n, s) => n + s.rateBp, 0) > MAX_RATE_BP) return { ok: false, error: "Shares can't add up to more than 10%." };
  return { ok: true };
}
