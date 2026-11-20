import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { parsePeriod, type PeriodKind } from "@/domain/periods";
import { REPORTS, buildTables, isReportKey, toCsv, toPdf } from "@/reports/export";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

/** CSV or PDF download of one report (or "all") for a week, month or year. Owners and Super Admin only. */
export async function GET(req: Request, ctx: { params: Promise<{ report: string }> }) {
  try {
    await requirePermission("reports.view");
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw e;
  }
  const { report } = await ctx.params;
  if (!isReportKey(report)) return new Response("Not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const kind = (["week", "month", "year"].includes(q.get("period") ?? "") ? q.get("period") : "month") as PeriodKind;
  let period;
  try {
    period = parsePeriod(kind, q.get("key") ?? "", TZ);
  } catch {
    return new Response("Bad period", { status: 400 });
  }
  const tables = await buildTables(report, period);
  const name = `book-clarity-${report}-${period.key}`;
  const title = report === "all" ? "Book Clarity reports" : `Book Clarity: ${REPORTS.find((r) => r.key === report)!.title}`;
  const headers = { "cache-control": "no-store" };
  if (q.get("format") === "pdf") {
    const pdf = await toPdf(title, period.label, tables);
    return new Response(Buffer.from(pdf), { headers: { ...headers, "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"` } });
  }
  return new Response(toCsv(tables), { headers: { ...headers, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
}
