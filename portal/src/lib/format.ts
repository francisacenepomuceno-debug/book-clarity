const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

export const fmtDate = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }) : "—";

/** "2026-11" → "November 2026" */
export const fmtMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** Today's date as "YYYY-MM-DD" in the business timezone (for date inputs). */
export const todayInTz = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
