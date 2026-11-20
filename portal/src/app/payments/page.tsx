import { can, requirePermission } from "@/auth/permissions";
import { monthlyPayments, PAYMENT_STATUS_LABEL, type PaymentStatus } from "@/payments/monthly";
import { periodOf, previous } from "@/domain/periods";
import { formatUsd } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";

export const dynamic = "force-dynamic";
const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const ORDER: PaymentStatus[] = ["FAILED", "SUSPENDED", "PROCESSING", "OPEN", "PAID", "PREPAID_ACE"];
const BADGE: Record<PaymentStatus, string> = { PAID: "CURRENT", FAILED: "PAST_DUE", SUSPENDED: "SUSPENDED", PROCESSING: "UNPAID", OPEN: "UNPAID", PREPAID_ACE: "PREPAID_ACE" };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ month?: string; status?: string }> }) {
  const viewer = await requirePermission("payments.view");
  const q = await searchParams;
  const now = new Date();
  const thisMonth = periodOf("month", now, TZ);
  let data;
  try {
    data = await monthlyPayments(q.month ?? thisMonth.key, viewer.role);
  } catch {
    data = await monthlyPayments(thisMonth.key, viewer.role);
  }
  const { month, rows, counts } = data;
  const prev = previous(month);
  const next = periodOf("month", month.end, TZ);
  const amounts = can(viewer.role, "payments.viewAmounts");
  const filter = ORDER.includes(q.status as PaymentStatus) ? (q.status as PaymentStatus) : null;
  const shown = filter ? rows.filter((r) => r.status === filter) : rows;
  const link = (m: string, s?: string | null) => `/payments?month=${m}${s ? `&status=${s}` : ""}`;

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Payments</h2>
        <section className="panel pad report-bar">
          <div className="period-nav">
            <a href={link(prev.key, filter)} aria-label="Previous month">←</a>
            <strong>{month.label}</strong>
            {next.start <= now ? <a href={link(next.key, filter)} aria-label="Next month">→</a> : <span className="muted">→</span>}
          </div>
          <span className="muted">Monthly bills whose billing period starts this month.</span>
        </section>
        <section className="kpis">
          <a href={link(month.key)} className={`kpi ${!filter ? "active" : ""}`}><div className="label">All</div><div className="value">{rows.length}</div></a>
          {ORDER.map((s) => (
            <a key={s} href={link(month.key, s)} className={`kpi ${filter === s ? "active" : ""}`}>
              <div className="label">{PAYMENT_STATUS_LABEL[s]}</div>
              <div className="value">{counts[s] ?? 0}</div>
            </a>
          ))}
        </section>
        <section className="panel">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Type</th>
                <th>Status</th>
                <th>Date</th>
                {amounts && <th>Method</th>}
                {amounts && <th className="num">Amount</th>}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={amounts ? 6 : 4} className="muted">No payments to show.</td></tr>}
              {shown.map((r, i) => (
                <tr key={`${r.href}-${i}`}>
                  <td><a href={r.href}>{r.name}</a></td>
                  <td>{r.type === "ACE" ? "ACE" : "Direct"}</td>
                  <td><span className={`badge s-${BADGE[r.status]}`}>{PAYMENT_STATUS_LABEL[r.status]}</span></td>
                  <td>{r.status === "PREPAID_ACE" ? `until ${fmtDate(r.date)}` : fmtDate(r.date)}</td>
                  {amounts && <td>{r.method ?? "—"}</td>}
                  {amounts && <td className="num">{r.amountCents != null ? formatUsd(r.amountCents) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
