import { can, requirePermission } from "@/auth/permissions";
import { listStatements } from "@/commissions/statements";
import { unassignedClients } from "@/commissions/splits";
import { monthOf } from "@/domain/commission";
import { db } from "@/lib/db";
import { formatUsd } from "@/lib/money";
import { fmtDate, fmtMonth, todayInTz } from "@/lib/format";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { PortalHeader } from "@/app/PortalHeader";
import { AddExecutiveForm, MarkPaidForm } from "./Forms";

export const dynamic = "force-dynamic";

export default async function CommissionsPage() {
  const viewer = await requirePermission("commissions.view");
  const canPay = can(viewer.role, "commissions.markPaid");
  const [statements, unassigned, executives] = await Promise.all([
    listStatements(),
    unassignedClients(),
    db.executive.findMany({ orderBy: { name: "asc" } }),
  ]);
  const thisMonth = monthOf(new Date(), process.env.BUSINESS_TZ ?? "America/New_York");
  const today = todayInTz();
  const unpaidTotal = statements.filter((s) => s.status === "OPEN").reduce((n, s) => n + s.totalCents, 0);

  return (
    <>
      <PortalHeader viewerName={viewer.name} showUsersLink={can(viewer.role, "users.manage")} showCommissionsLink />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Commissions</h2>

        <section className="kpis">
          <div className="kpi"><div className="label">Unpaid commission</div><div className="value">{formatUsd(unpaidTotal)}</div><div className="sub">all open statements</div></div>
          <div className="kpi"><div className="label">Clients without an owner</div><div className="value">{unassigned.length}</div></div>
        </section>

        <section className="panel">
          <table>
            <thead>
              <tr><th>Month</th><th>Executive</th><th className="num">Lines</th><th className="num">Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={`${s.executiveId}-${s.month}`}>
                  <td><a href={`/commissions/${s.executiveId}/${s.month}`}>{fmtMonth(s.month)}</a></td>
                  <td>{s.executiveName}</td>
                  <td className="num">{s.lineCount}</td>
                  <td className="num">{formatUsd(s.totalCents)}</td>
                  <td>{s.status === "PAID" ? `Paid ${fmtDate(s.paidAt)}` : s.month === thisMonth ? "In progress" : "Unpaid"}</td>
                  <td>{canPay && s.status === "OPEN" && s.month < thisMonth && <MarkPaidForm executiveId={s.executiveId} month={s.month} today={today} />}</td>
                </tr>
              ))}
              {statements.length === 0 && <tr><td colSpan={6} className="muted">No commission yet. Set a commission owner on a client to start.</td></tr>}
            </tbody>
          </table>
        </section>

        <div className="two-col">
          <section className="panel pad">
            <h3>Clients without a commission owner</h3>
            {unassigned.length === 0 ? (
              <p className="muted">Every active client has an owner.</p>
            ) : (
              <ul className="plain">
                {unassigned.map((c) => (
                  <li key={c.id}>
                    {c.stripeSubscriptionId ? <a href={`/clients/${c.stripeSubscriptionId}#commission`}>{c.name}</a> : c.name}{" "}
                    <span className="muted">· {STATUS_LABEL[c.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel pad">
            <h3>Executives</h3>
            <ul className="plain">
              {executives.map((e) => <li key={e.id}>{e.name}{!e.active && <span className="muted"> (inactive)</span>}</li>)}
              {executives.length === 0 && <li className="muted">None yet. Add Jose and Albert.</li>}
            </ul>
            {canPay && <AddExecutiveForm />}
          </section>
        </div>
      </main>
    </>
  );
}
