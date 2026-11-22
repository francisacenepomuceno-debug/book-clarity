/** Notice before a current client's new price starts (owner, 2026-11-22). */
export const PRICE_NOTICE_DAYS = 30;
/** Clients are moved for this long after the start date (anyone whose bill comes later is past a full cycle). */
export const PRICE_CHANGE_WINDOW_DAYS = 62;

/** Same day-of-month one month later (clamped to the month's last day), keeping the time of day. */
export function addMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

/** Pure: a monthly client's first bill on or after the start date, given the end of their current billing period. */
export function firstBillOnOrAfter(periodEnd: Date, effectiveAt: Date): Date {
  let r = periodEnd;
  for (let i = 0; i < 24 && r < effectiveAt; i++) r = addMonth(r);
  return r;
}

/** Pure: when the notice is due for a client whose new price starts on `startsOn`. */
export const noticeDueAt = (startsOn: Date) => new Date(startsOn.getTime() - PRICE_NOTICE_DAYS * 86400_000);
