import { requirePermission } from "@/auth/permissions";
import { listBatches } from "@/ace/batches";
import { dueForContinuation } from "@/ace/continuation";
import { listPackages } from "@/packages/packages";
import { formatUsd } from "@/lib/money";
import { fmtDate, todayInTz } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { ContinuationButtons, NewBatchForm } from "./Forms";

export const dynamic = "force-dynamic";

export default async function AcePage() {
  const viewer = await requirePermission("ace.manage");
  const [batches, due, packages] = await Promise.all([listBatches(), dueForContinuation(), listPackages()]);
  const today = todayInTz();
  const openSlots = batches.reduce((n, b) => n + b.packages.reduce((m, p) => m + p.open, 0), 0);

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>ACE batches</h2>
        <section className="kpis">
          <div className="kpi"><div className="label">Batches</div><div className="value">{batches.length}</div></div>
          <div className="kpi"><div className="label">Open slots</div><div className="value">{openSlots}</div></div>
          <div className="kpi"><div className="label">Unpaid batches</div><div className="value">{batches.filter((b) => !b.paidAt).length}</div></div>
          <div className="kpi"><div className="label">Coming up on month 6</div><div className="value">{due.length}</div></div>
        </section>

        {due.length > 0 && (
          <section className="panel pad">
            <h3>Coming up on month 6</h3>
            <p className="muted">Ask each client whether they'll continue. "Continuing" gives you a link for them to set up autopay; their first charge is the day after the prepaid period.</p>
            <table>
              <thead><tr><th>Client</th><th>Prepaid until</th><th>Decision</th><th></th></tr></thead>
              <tbody>
                {due.map((c) => (
                  <tr key={c.clientId}>
                    <td><a href={`/clients/${c.clientId}`}>{c.name}</a></td>
                    <td>{fmtDate(c.prepaidUntil)}</td>
                    <td>{c.decision === "CONTINUING" ? "Continuing — waiting for payment method" : c.decision === "ENDING" ? "Not continuing" : "Not asked yet"}</td>
                    <td>{c.decision !== "ENDING" && <ContinuationButtons clientId={c.clientId} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="panel" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th>Purchased</th><th>Slots</th><th className="num">Total</th><th>Payment</th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td><a href={`/ace/${b.id}`}>{fmtDate(b.purchasedAt)}</a>{b.note && <div className="muted">{b.note}</div>}</td>
                  <td>{b.packages.map((p) => `${p.name}: ${p.used}/${p.quantity} used`).join(" · ")}</td>
                  <td className="num">{formatUsd(b.totalCents)}</td>
                  <td>{b.paidAt ? `Paid ${fmtDate(b.paidAt)}${b.paidVia === "OUT_OF_BAND" ? ` (${b.paymentMethod})` : ""}` : <strong>Unpaid</strong>}</td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td colSpan={4} className="muted">No batches yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="panel pad" style={{ marginTop: 16 }}>
          <h3>New batch</h3>
          {packages.length === 0 ? (
            <p className="muted">Add your packages in <a href="/settings/packages">Packages</a> first.</p>
          ) : (
            <NewBatchForm packages={packages.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, isCustom: p.isCustom }))} today={today} />
          )}
        </section>
      </main>
    </>
  );
}
