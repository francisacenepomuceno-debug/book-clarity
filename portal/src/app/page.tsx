import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { STATUS_LABEL, type ClientStatus } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import type { LiveClientRow } from "@/stripe/mapSubscription";

export const dynamic = "force-dynamic";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }) : "—";

const FILTERS: { key: ClientStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "All clients" },
  { key: "CURRENT", label: STATUS_LABEL.CURRENT },
  { key: "UNPAID", label: STATUS_LABEL.UNPAID },
  { key: "PAST_DUE", label: STATUS_LABEL.PAST_DUE },
  { key: "AT_RISK", label: STATUS_LABEL.AT_RISK },
  { key: "PAUSED", label: STATUS_LABEL.PAUSED },
];

const ORDER: ClientStatus[] = ["AT_RISK", "PAST_DUE", "UNPAID", "PAUSED", "CURRENT"];

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ status?: string; refresh?: string }> }) {
  const { status = "ALL", refresh } = await searchParams;

  let snap;
  try {
    snap = await getLiveSnapshot(refresh === "1");
  } catch (e) {
    return (
      <main>
        <div className="error">
          <strong>Couldn't load Stripe data.</strong> {(e as Error).message}
        </div>
      </main>
    );
  }

  const rows = snap.rows;
  const count = (s: ClientStatus) => rows.filter((r) => r.status === s).length;
  const billing = rows.filter((r) => r.status !== "PAUSED" && r.status !== "ENDED");
  const mrr = billing.reduce((n, r) => n + r.packageMonthlyCents, 0);
  const feeMrr = billing.reduce((n, r) => n + r.cardFeeMonthlyCents, 0);
  const due = rows.reduce((n, r) => n + r.amountDueCents, 0);

  const shown = (status === "ALL" ? rows : rows.filter((r) => r.status === status)).sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <header>
        <h1>Book Clarity · Client Dashboard</h1>
        <small>
          {snap.livemode ? "Live Stripe data" : "Stripe TEST data"} · updated{" "}
          {snap.fetchedAt.toLocaleTimeString("en-US", { timeZone: TZ })} · <a href={`/?status=${status}&refresh=1`}>Refresh</a>
        </small>
      </header>
      <main>
        <section className="kpis">
          {FILTERS.map((f) => (
            <a key={f.key} href={`/?status=${f.key}`} className={`kpi ${status === f.key ? "active" : ""}`}>
              <div className="label">{f.label}</div>
              <div className="value">{f.key === "ALL" ? rows.length : count(f.key)}</div>
            </a>
          ))}
          <div className="kpi">
            <div className="label">Monthly package revenue</div>
            <div className="value">{formatUsd(mrr)}</div>
            <div className="sub">before discounts · excl. card fees</div>
          </div>
          <div className="kpi">
            <div className="label">Card fees / month</div>
            <div className="value">{formatUsd(feeMrr)}</div>
          </div>
          <div className="kpi">
            <div className="label">Not on autopay</div>
            <div className="value">{rows.filter((r) => !r.autopay).length}</div>
            <div className="sub">billed by emailed invoice</div>
          </div>
          <div className="kpi">
            <div className="label">Outstanding</div>
            <div className="value">{formatUsd(due)}</div>
            <div className="sub">open invoices</div>
          </div>
        </section>

        <section className="panel">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Package</th>
                <th className="num">Monthly</th>
                <th className="num">Card fee</th>
                <th>Payment method</th>
                <th>Next charge</th>
                <th className="num">Amount due</th>
                <th>Past due since</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row key={r.subscriptionId} r={r} livemode={snap.livemode} />
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">No clients in this group.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <p className="note">
          Read-only view of every non-cancelled Stripe subscription. Monthly = list price of package items before discounts.
          Direct vs ACE and commission owners appear after the commission spreadsheet is imported.
        </p>
      </main>
    </>
  );
}

function Row({ r, livemode }: { r: LiveClientRow; livemode: boolean }) {
  const dash = `https://dashboard.stripe.com/${livemode ? "" : "test/"}subscriptions/${r.subscriptionId}`;
  return (
    <tr>
      <td>
        <a href={dash} target="_blank" rel="noreferrer">{r.name}</a>
        {r.email && <div className="muted">{r.email}</div>}
      </td>
      <td><span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
      <td>
        {r.packageName}
        {r.sixMonthContract && <span className="muted"> · 6-month</span>}
        {r.hasDiscount && <span className="muted"> · discount</span>}
      </td>
      <td className="num">{formatUsd(r.packageMonthlyCents)}</td>
      <td className="num">{r.cardFeeMonthlyCents ? formatUsd(r.cardFeeMonthlyCents) : "—"}</td>
      <td>{r.paymentMethod}</td>
      <td>{fmtDate(r.nextChargeDate)}</td>
      <td className="num">{r.amountDueCents ? formatUsd(r.amountDueCents) : "—"}</td>
      <td>{fmtDate(r.pastDueSince)}</td>
    </tr>
  );
}
