import { startOfDayIn } from "@/domain/commission";

export type PeriodKind = "week" | "month" | "year";
export type Period = { kind: PeriodKind; tz: string; key: string; label: string; start: Date; end: Date };

const DAY = 86400_000;
/** A calendar day as a UTC-midnight "civil date" (no time zone). */
type Civil = Date;
const civil = (y: number, m: number, d: number): Civil => new Date(Date.UTC(y, m - 1, d));
const ymd = (c: Civil) => c.toISOString().slice(0, 10);
const startOf = (c: Civil, tz: string) => startOfDayIn(ymd(c), tz);

/** The calendar day a moment falls on in the time zone. */
function localDay(d: Date, tz: string): Civil {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return civil(+p.year, +p.month, +p.day);
}

const mondayOf = (c: Civil): Civil => new Date(c.getTime() - ((c.getUTCDay() + 6) % 7) * DAY);
/** ISO week-numbering year and week of the week starting on `monday`. */
function isoWeek(monday: Civil): { year: number; week: number } {
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week1 = mondayOf(civil(year, 1, 4));
  return { year, week: Math.round((monday.getTime() - week1.getTime()) / (7 * DAY)) + 1 };
}

function build(kind: PeriodKind, first: Civil, tz: string): Period {
  if (kind === "week") {
    const next = new Date(first.getTime() + 7 * DAY);
    const { year, week } = isoWeek(first);
    const label = `Week of ${first.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })}`;
    return { kind, tz, key: `${year}-W${String(week).padStart(2, "0")}`, label, start: startOf(first, tz), end: startOf(next, tz) };
  }
  if (kind === "month") {
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth() + 1;
    const next = m === 12 ? civil(y + 1, 1, 1) : civil(y, m + 1, 1);
    const label = first.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
    return { kind, tz, key: `${y}-${String(m).padStart(2, "0")}`, label, start: startOf(first, tz), end: startOf(next, tz) };
  }
  const y = first.getUTCFullYear();
  return { kind, tz, key: String(y), label: String(y), start: startOf(civil(y, 1, 1), tz), end: startOf(civil(y + 1, 1, 1), tz) };
}

/** The period of the given kind that contains `anchor`, in the business time zone. */
export function periodOf(kind: PeriodKind, anchor: Date, tz: string): Period {
  const day = localDay(anchor, tz);
  if (kind === "week") return build(kind, mondayOf(day), tz);
  if (kind === "month") return build(kind, civil(day.getUTCFullYear(), day.getUTCMonth() + 1, 1), tz);
  return build(kind, civil(day.getUTCFullYear(), 1, 1), tz);
}

/** "2026-W47" | "2026-11" | "2026" → period. Throws on a malformed key. */
export function parsePeriod(kind: PeriodKind, key: string, tz: string): Period {
  if (kind === "week") {
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    if (!m) throw new Error(`Bad week: ${key}`);
    const monday = new Date(mondayOf(civil(+m[1], 1, 4)).getTime() + (+m[2] - 1) * 7 * DAY);
    const p = build("week", monday, tz);
    if (p.key !== key) throw new Error(`Bad week: ${key}`);
    return p;
  }
  if (kind === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m || +m[2] < 1 || +m[2] > 12) throw new Error(`Bad month: ${key}`);
    return build("month", civil(+m[1], +m[2], 1), tz);
  }
  if (!/^\d{4}$/.test(key)) throw new Error(`Bad year: ${key}`);
  return build("year", civil(+key, 1, 1), tz);
}

/** The period just before. */
export function previous(p: Period): Period {
  return periodOf(p.kind, new Date(p.start.getTime() - 1), p.tz);
}

/** The `n` periods ending with `last`, oldest first. */
export function bucketsBetween(last: Period, n: number): Period[] {
  const out = [last];
  while (out.length < n) out.unshift(previous(out[0]));
  return out;
}

/** Change from the previous value; the percentage is null when there's nothing to compare with. */
export function change(current: number, prev: number): { delta: number; pct: number | null } {
  return { delta: current - prev, pct: prev === 0 ? null : Math.round(((current - prev) / Math.abs(prev)) * 1000) / 10 };
}
