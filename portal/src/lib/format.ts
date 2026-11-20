const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

export const fmtDate = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }) : "—";
