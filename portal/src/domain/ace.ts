import { startOfDayIn } from "@/domain/commission";

export const ACE_PREPAID_MONTHS = 6;
/** ACE clients are first told 60 days before their prepaid period ends (owner, 2026-11-20). */
export const CONTINUATION_NOTICE_DAYS = 60;
export const CONTINUATION_REMINDER_DAYS = [60, 30, 14] as const;

/**
 * Last instant of an ACE client's prepaid period: the end of the day before the same day-of-month 6 months
 * after `startDay` (clamped to the end of a shorter month), in the business timezone.
 */
export function prepaidUntil(startDay: string, tz: string): Date {
  const [y, m, d] = startDay.split("-").map(Number);
  const targetIndex = m - 1 + ACE_PREPAID_MONTHS;
  const ty = y + Math.floor(targetIndex / 12);
  const tm = (targetIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const boundary = `${ty}-${String(tm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(startOfDayIn(boundary, tz).getTime() - 1);
}

export function continuationDueAt(prepaidUntilAt: Date): Date {
  return new Date(prepaidUntilAt.getTime() - CONTINUATION_NOTICE_DAYS * 24 * 3600_000);
}

export function batchTotals(lines: { quantity: number; unitPriceCents: number }[]): number {
  return lines.reduce((n, l) => n + l.quantity * l.unitPriceCents, 0);
}

/** ACE months 1–6 commission base: 6 × the package's monthly list price (spec Q1). */
export function aceLumpBase(i: { monthlyListCents: number }): number {
  return ACE_PREPAID_MONTHS * i.monthlyListCents;
}
