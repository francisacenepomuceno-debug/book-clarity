import { requirePermission } from "@/auth/permissions";
import { parsePeriod, periodOf, previous, type Period, type PeriodKind } from "@/domain/periods";
import { REPORTS, buildTables, mrrTrend } from "@/reports/export";
import { formatUsd } from "@/lib/money";
import { PortalHeader } from "@/app/PortalHeader";
import { BarTrend } from "./BarTrend";

export const dynamic = "force-dynamic";
const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const KINDS: { kind: PeriodKind; label: string }[] = [
  { kind: "week", label: "Week" },
  { kind: "month", label: "Month" },
  { kind: "year", label: "Year" },
];

function shortLabel(p: Period) {
  if (p.kind === "year") return p.key;
  if (p.kind === "month") return p.start.toLocaleDateString("en-US", { timeZone: TZ, month: "short" });
  return p.start.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ period?: string; key?: string }> }) {
  const viewer = await requirePermission("reports.view");
  const q = await searchParams;
  const kind: PeriodKind = q.period === "week" || q.period === "year" ? q.period : "month";
  const now = new Date();
  let period: Period;
  try {
    period = q.key ? parsePeriod(kind, q.key, TZ) : periodOf(kind, now, TZ);
  } catch {
    period = periodOf(kind, now, TZ);
  }
  const prev = previous(period);
  const next = periodOf(kind, period.end, TZ);
  const href = (p: Period) => `/reports?period=${p.kind}&key=${p.key}`;
  const dl = (report: string, format: "csv" | "pdf") => `/api/reports/${report}?period=${period.kind}&key=${period.key}&format=${format}`;

  const [sections, trend] = await Promise.all([
    Promise.all(REPORTS.map(async (r) => ({ ...r, tables: await buildTables(r.key, period, now) }))),
    mrrTrend(period, now),
  ]);

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← Dashboard</a></p>
        <h2>Reports</h2>
        <p className="muted">A period still in progress is marked “(so far)”. Cash collected, by payment date ({TZ.replace("_", " ")}). Each figure is compared with the previous {kind}. Refunds count against the period of the original payment.</p>
        <section className="panel pad report-bar">
          <nav className="tabs">
            {KINDS.map((k) => (
              <a key={k.kind} href={`/reports?period=${k.kind}`} className={k.kind === kind ? "active" : ""}>{k.label}</a>
            ))}
          </nav>
          <div className="period-nav">
            <a href={href(prev)} aria-label="Previous period">←</a>
            <strong>{period.label}</strong>
            {next.start <= now ? <a href={href(next)} aria-label="Next period">→</a> : <span className="muted">→</span>}
          </div>
          <div className="downloads">
            Everything: <a href={dl("all", "csv")}>CSV</a> · <a href={dl("all", "pdf")}>PDF</a>
          </div>
        </section>

        {sections.map((s) => (
          <section className="panel pad" key={s.key} id={s.key}>
            <div className="section-head">
              <h3>{s.title}</h3>
              <span className="downloads"><a href={dl(s.key, "csv")}>CSV</a> · <a href={dl(s.key, "pdf")}>PDF</a></span>
            </div>
            {s.key === "active-mrr" && (
              <div className="two-col">
                <BarTrend title="Active clients" points={trend.map((t) => ({ label: t.label, short: shortLabel(t.period), value: t.active, display: String(t.active) }))} />
                <BarTrend title="Monthly recurring revenue" points={trend.map((t) => ({ label: t.label, short: shortLabel(t.period), value: t.mrrCents, display: formatUsd(t.mrrCents) }))} />
              </div>
            )}
            {s.tables.map((t) => (
              <div key={t.title} className="report-table">
                {s.tables.length > 1 && <h4>{t.title}</h4>}
                {t.rows.length === 0 ? (
                  <p className="muted">None in this period.</p>
                ) : (
                  <table>
                    <thead><tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {t.rows.map((r, i) => (
                        <tr key={i} className={/^Total/.test(r[0]) ? "total" : ""}>{r.map((c, j) => <td key={j} className={j > 0 ? "num" : ""}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </section>
        ))}
      </main>
    </>
  );
}
