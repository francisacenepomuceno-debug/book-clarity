import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { listBatches } from "@/ace/batches";
import { dueForContinuation } from "@/ace/continuation";
import { listPackages } from "@/packages/packages";
import { aceSlotOverview } from "@/ace/overview";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { fmtDate, todayInTz } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { ContinuationButtons, NewBatchForm } from "./Forms";

export const dynamic = "force-dynamic";

export default async function AcePage({ searchParams }: { searchParams: Promise<{ package?: string }> }) {
  const viewer = await requirePermission("ace.manage");
  const { package: packageFilter } = await searchParams;
  const [batches, due, packages, overview, executives] = await Promise.all([
    listBatches(),
    dueForContinuation(),
    listPackages(),
    aceSlotOverview({ packageId: packageFilter || undefined }),
    db.executive.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
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

        <section className="panel" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr><th>Package</th><th className="num">Slots bought</th><th className="num">Used</th><th className="num">Available</th><th></th></tr>
            </thead>
            <tbody>
              {overview.byPackage.map((p) => (
                <tr key={p.packageId}>
                  <td><a href={`/ace?package=${p.packageId}#slots`}>{p.name}</a></td>
                  <td className="num">{p.bought}</td>
                  <td className="num">{p.used}</td>
                  <td className="num"><strong>{p.available}</strong></td>
                  <td className="muted">{p.availableInUnpaidBatches > 0 ? `${p.availableInUnpaidBatches} of these in batches ACE hasn't paid yet` : ""}</td>
                </tr>
              ))}
              {overview.byPackage.length === 0 && <tr><td colSpan={5} className="muted">No slots yet. Record ACE's first batch below.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="panel pad" id="slots" style={{ marginBottom: 16 }}>
          <h3>Who's in which slot</h3>
          <p className="muted">
            Show:{" "}
            <a href="/ace#slots">{packageFilter ? "All packages" : <strong>All packages</strong>}</a>
            {overview.byPackage.map((p) => (
              <span key={p.packageId}>
                {" · "}
                <a href={`/ace?package=${p.packageId}#slots`}>{packageFilter === p.packageId ? <strong>{p.name}</strong> : p.name}</a>
              </span>
            ))}
          </p>
          <table>
            <thead><tr><th>Client</th><th>Package</th><th>Status</th><th>Start</th><th>Prepaid until</th><th>Batch</th></tr></thead>
            <tbody>
              {overview.assigned.map((s) => (
                <tr key={s.slotId}>
                  <td><a href={`/clients/${s.clientId}`}>{s.clientName}</a></td>
                  <td>{s.packageName}</td>
                  <td>
                    <span className={`badge s-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                    {s.continuationDecision === "CONTINUING" && <span className="muted"> · continuing</span>}
                    {s.continuationDecision === "ENDING" && <span className="muted"> · not continuing</span>}
                  </td>
                  <td>{fmtDate(s.startDate)}</td>
                  <td>{fmtDate(s.prepaidUntil)}</td>
                  <td><a href={`/ace/${s.batchId}`}>{s.batchPaid ? "Paid batch" : "Unpaid batch"}</a></td>
                </tr>
              ))}
              {overview.assigned.length === 0 && <tr><td colSpan={6} className="muted">No clients in slots{packageFilter ? " for this package" : ""} yet.</td></tr>}
            </tbody>
          </table>
        </section>

        {due.length > 0 && (
          <section className="panel pad">
            <h3>Coming up on month 6</h3>
            <p className="muted">Clients are emailed 60, 30 and 14 days before the end and can answer Yes or No themselves. A "No" ends nothing: follow up, and mark them continuing if you win them back. Service ends only when you confirm it.</p>
            <table>
              <thead><tr><th>Client</th><th>Prepaid until</th><th>Client's answer</th><th>Decision</th><th></th></tr></thead>
              <tbody>
                {due.map((c) => (
                  <tr key={c.clientId}>
                    <td><a href={`/clients/${c.clientId}`}>{c.name}</a></td>
                    <td>{fmtDate(c.prepaidUntil)}</td>
                    <td>{c.clientAnswer === "YES" ? `Yes (${fmtDate(c.clientAnsweredAt)})` : c.clientAnswer === "NO" ? `No (${fmtDate(c.clientAnsweredAt)})` : "No answer yet"}</td>
                    <td>{c.decision === "CONTINUING" ? "Continuing — waiting for payment method" : c.decision === "ENDING" ? "End confirmed" : "Open"}</td>
                    <td><ContinuationButtons clientId={c.clientId} decision={c.decision} /></td>
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
            <NewBatchForm packages={packages.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, isCustom: p.isCustom }))} today={today} executives={executives} />
          )}
        </section>
      </main>
    </>
  );
}
