import { ClientSearch } from "./ClientSearch";
import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { STATUS_LABEL, type ClientStatus } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { can, requirePermission } from "@/auth/permissions";
import { aceDashboardRows, scopeRow, withClientTypes, withPricing, type ClientRow } from "@/clients/queries";
import { periodOf } from "@/domain/periods";
import { expectedVsCollected } from "@/reports/queries";
import { dashboardAlerts } from "@/reports/alerts";
import { PortalHeader } from "@/app/PortalHeader";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";


const FILTERS: { key: ClientStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "Total" },
  { key: "CURRENT", label: STATUS_LABEL.CURRENT },
  { key: "UNPAID", label: STATUS_LABEL.UNPAID },
  { key: "PAST_DUE", label: STATUS_LABEL.PAST_DUE },
  { key: "AT_RISK", label: STATUS_LABEL.AT_RISK },
  { key: "SUSPENDED", label: STATUS_LABEL.SUSPENDED },
  { key: "PAUSED", label: STATUS_LABEL.PAUSED },
  { key: "PREPAID_ACE", label: STATUS_LABEL.PREPAID_ACE },
  { key: "ACE_AWAITING_DECISION", label: STATUS_LABEL.ACE_AWAITING_DECISION },
];
const ORDER: ClientStatus[] = ["SUSPENDED", "AT_RISK", "PAST_DUE", "UNPAID", "ACE_AWAITING_DECISION", "CONTINUING_AWAITING_PM", "PAUSED", "CURRENT", "PREPAID_ACE", "ONBOARDING"];
const sum = (rows: ClientRow[], f: (r: ClientRow) => number | undefined) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);

/** Owner and Super Admin only: this month's expected vs collected, and what needs attention. */
async function OwnerPanels() {
  const month = periodOf("month", new Date(), process.env.BUSINESS_TZ ?? "America/New_York");
  const [ec, alerts] = await Promise.all([expectedVsCollected(month), dashboardAlerts()]);
  const pct = ec.expectedCents ? Math.min(100, Math.round((ec.collectedCents / ec.expectedCents) * 100)) : 0;
  return (
    <div className="two-col owner-panels">
      <section className="panel pad">
        <h3>{month.label}: collected so far</h3>
        <p className="big">{formatUsd(ec.collectedCents)} <span className="muted">of {formatUsd(ec.expectedCents)} expected</span></p>
        <div className="meter" role="img" aria-label={`${pct}% collected`}><span style={{ width: `${pct}%` }} /></div>
        <p className="muted">{pct}% of this month's monthly bills collected · Past due: <strong>{formatUsd(ec.outstandingPastDueCents)}</strong> · <a href="/reports">Reports</a></p>
      </section>
      <section className="panel pad">
        <h3>Needs attention</h3>
        {alerts.length === 0 ? (
          <p className="muted">Nothing needs attention right now.</p>
        ) : (
          alerts.map((g) => (
            <details key={g.kind} className="alert-group" open={g.items.length <= 3}>
              <summary><strong>{g.title}</strong> <span className="count">{g.items.length}</span></summary>
              <ul className="plain">
                {g.items.map((i) => <li key={i.href + i.name}><a href={i.href}>{i.name}</a> <span className="muted">· {i.detail}</span></li>)}
              </ul>
            </details>
          ))
        )}
      </section>
    </div>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ status?: string; refresh?: string; type?: string }> }) {
  const viewer = await requirePermission("clients.view");
  const money = can(viewer.role, "clients.viewFinancials");
  const owner = can(viewer.role, "reports.view");
  const canRevert = can(viewer.role, "discounts.apply");
  const { status = "ALL", refresh, type: typeParam } = await searchParams;
  const type: "ALL" | "DIRECT" | "ACE" = typeParam === "DIRECT" || typeParam === "ACE" ? typeParam : "ALL";
  const q = (o: { status?: string; type?: string }) => {
    const p = new URLSearchParams();
    const s = o.status ?? status;
    const ty = o.type ?? type;
    if (s !== "ALL") p.set("status", s);
    if (ty !== "ALL") p.set("type", ty);
    const str = p.toString();
    return str ? `/?${str}` : "/";
  };

  let snap;
  try {
    snap = await getLiveSnapshot(refresh === "1");
  } catch (e) {
    console.error("[dashboard] Stripe load failed:", (e as Error).message);
    return (
      <main>
        <div className="error">
          <strong>Couldn't load Stripe data.</strong> Try Refresh in a minute; if it keeps failing, check the Stripe key.
        </div>
      </main>
    );
  }

  const allRows = [...(await withPricing(await withClientTypes(snap.rows))), ...(await aceDashboardRows())].map((r) => scopeRow(r, viewer.role));
  const typeCount = { ALL: allRows.length, DIRECT: allRows.filter((r) => r.clientType !== "ACE").length, ACE: allRows.filter((r) => r.clientType === "ACE").length };
  // Direct and ACE clients are shown separately (everything below follows the chosen type).
  const rows = type === "ALL" ? allRows : allRows.filter((r) => (type === "ACE" ? r.clientType === "ACE" : r.clientType !== "ACE"));
  const count = (s: ClientStatus) => rows.filter((r) => r.status === s).length;
  const billing = rows.filter((r) => r.status !== "PAUSED" && r.status !== "ENDED");
  const shown = (status === "ALL" ? rows : rows.filter((r) => r.status === status)).sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} livemode={snap.livemode} fetchedAt={snap.fetchedAt} refreshHref={`${q({})}${q({}).includes("?") ? "&" : "?"}refresh=1`} />
      <main>
        <nav className="tabs type-tabs" aria-label="Client type">
          {([["ALL", "All clients"], ["DIRECT", "Direct"], ["ACE", "ACE"]] as const).map(([k, label]) => (
            <a key={k} href={q({ type: k, status: "ALL" })} className={type === k ? "active" : ""}>
              {label} <span className="tab-count">{typeCount[k]}</span>
            </a>
          ))}
        </nav>
        <section className="kpis">
          {FILTERS.map((f) => (
            <a key={f.key} href={q({ status: f.key })} className={`kpi ${status === f.key ? "active" : ""}`}>
              <div className="label">{f.label}</div>
              <div className="value">{f.key === "ALL" ? rows.length : count(f.key)}</div>
            </a>
          ))}
          {money && (
            <>
              <div className="kpi">
                <div className="label">Monthly package revenue</div>
                <div className="value">{formatUsd(sum(billing, (r) => r.packageMonthlyCents))}</div>
                <div className="sub">before discounts · excl. card fees</div>
              </div>
              <div className="kpi">
                <div className="label">Card fees / month</div>
                <div className="value">{formatUsd(sum(billing, (r) => r.cardFeeMonthlyCents))}</div>
              </div>
              <div className="kpi">
                <div className="label">Not on autopay</div>
                <div className="value">{rows.filter((r) => r.autopay === false && r.clientType !== "ACE").length}</div>
                <div className="sub">billed by emailed invoice</div>
              </div>
              <div className="kpi">
                <div className="label">Outstanding</div>
                <div className="value">{formatUsd(sum(rows, (r) => r.amountDueCents))}</div>
                <div className="sub">open invoices</div>
              </div>
            </>
          )}
        </section>

        {owner && <OwnerPanels />}

        <ClientSearch tableId="client-table" />
        <section className="panel">
          <table id="client-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Type</th>
                <th>Package</th>
                {money && <th className="num">Monthly</th>}
                {money && <th>Discounted</th>}
                {money && <th className="num">Card fee</th>}
                {money && <th>Payment method</th>}
                <th>Next charge</th>
                {money && <th className="num">Amount due</th>}
                <th>Past due since</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.subscriptionId} data-search={[r.name, r.email ?? "", r.packageName ?? ""].join(" ").toLowerCase()}>
                  <td>
                    <a href={`/clients/${r.subscriptionId}`}>{r.name}</a>
                    {r.email && <div className="muted">{r.email}</div>}
                  </td>
                  <td><span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  <td>{r.clientType === "ACE" ? "ACE" : "Direct"}</td>
                  <td>
                    {r.packageName}
                    {r.sixMonthContract && <span className="muted"> · 6-month</span>}
                  </td>
                  {money && <td className="num">{formatUsd(r.packageMonthlyCents ?? 0)}</td>}
                  {money && (
                    <td>
                      {r.discounted ? (
                        <>
                          <strong className="discounted">Yes</strong>
                          {r.listPriceCents && (r.packageMonthlyCents ?? 0) < r.listPriceCents && <span className="muted"> · list {formatUsd(r.listPriceCents)}</span>}
                          {r.hasDiscount && <span className="muted"> · coupon</span>}
                          {canRevert && <> · <a href={`/clients/${r.subscriptionId}#price`}>Revert</a></>}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  {money && <td className="num">{r.cardFeeMonthlyCents ? formatUsd(r.cardFeeMonthlyCents) : "—"}</td>}
                  {money && <td>{r.paymentMethod}</td>}
                  <td>{fmtDate(r.nextChargeDate)}</td>
                  {money && <td className="num">{r.amountDueCents ? formatUsd(r.amountDueCents) : "—"}</td>}
                  <td>{fmtDate(r.pastDueSince)}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={money ? 11 : 6} className="muted">No clients in this group.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <p className="note">
          Live from Stripe (read-only). Monthly = list price of package items before discounts. Direct vs ACE and commission
          owners appear after the commission spreadsheet is imported.
        </p>
      </main>
    </>
  );
}
