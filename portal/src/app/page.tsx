import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { STATUS_LABEL, type ClientStatus } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { can, requirePermission } from "@/auth/permissions";
import { scopeRow, type ClientRow } from "@/clients/queries";
import { PortalHeader } from "@/app/PortalHeader";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";


const FILTERS: { key: ClientStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "All clients" },
  { key: "CURRENT", label: STATUS_LABEL.CURRENT },
  { key: "UNPAID", label: STATUS_LABEL.UNPAID },
  { key: "PAST_DUE", label: STATUS_LABEL.PAST_DUE },
  { key: "AT_RISK", label: STATUS_LABEL.AT_RISK },
  { key: "PAUSED", label: STATUS_LABEL.PAUSED },
];
const ORDER: ClientStatus[] = ["AT_RISK", "PAST_DUE", "UNPAID", "PAUSED", "CURRENT"];
const sum = (rows: ClientRow[], f: (r: ClientRow) => number | undefined) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ status?: string; refresh?: string }> }) {
  const viewer = await requirePermission("clients.view");
  const money = can(viewer.role, "clients.viewFinancials");
  const { status = "ALL", refresh } = await searchParams;

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

  const rows = snap.rows.map((r) => scopeRow(r, viewer.role));
  const count = (s: ClientStatus) => rows.filter((r) => r.status === s).length;
  const billing = rows.filter((r) => r.status !== "PAUSED" && r.status !== "ENDED");
  const shown = (status === "ALL" ? rows : rows.filter((r) => r.status === status)).sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <PortalHeader viewerName={viewer.name} livemode={snap.livemode} fetchedAt={snap.fetchedAt} refreshHref={`/?status=${status}&refresh=1`} />
      <main>
        <section className="kpis">
          {FILTERS.map((f) => (
            <a key={f.key} href={`/?status=${f.key}`} className={`kpi ${status === f.key ? "active" : ""}`}>
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
                <div className="value">{rows.filter((r) => r.autopay === false).length}</div>
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

        <section className="panel">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Status</th>
                <th>Package</th>
                {money && <th className="num">Monthly</th>}
                {money && <th className="num">Card fee</th>}
                {money && <th>Payment method</th>}
                <th>Next charge</th>
                {money && <th className="num">Amount due</th>}
                <th>Past due since</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.subscriptionId}>
                  <td>
                    <a href={`/clients/${r.subscriptionId}`}>{r.name}</a>
                    {r.email && <div className="muted">{r.email}</div>}
                  </td>
                  <td><span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  <td>
                    {r.packageName}
                    {r.sixMonthContract && <span className="muted"> · 6-month</span>}
                    {r.hasDiscount && <span className="muted"> · discount</span>}
                  </td>
                  {money && <td className="num">{formatUsd(r.packageMonthlyCents ?? 0)}</td>}
                  {money && <td className="num">{r.cardFeeMonthlyCents ? formatUsd(r.cardFeeMonthlyCents) : "—"}</td>}
                  {money && <td>{r.paymentMethod}</td>}
                  <td>{fmtDate(r.nextChargeDate)}</td>
                  {money && <td className="num">{r.amountDueCents ? formatUsd(r.amountDueCents) : "—"}</td>}
                  <td>{fmtDate(r.pastDueSince)}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={money ? 9 : 5} className="muted">No clients in this group.</td>
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
