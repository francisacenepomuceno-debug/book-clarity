import { notFound } from "next/navigation";
import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { getStripe } from "@/stripe/client";
import { can, requirePermission } from "@/auth/permissions";
import { scopeRow } from "@/clients/queries";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { db } from "@/lib/db";
import { PortalHeader } from "@/app/PortalHeader";
import { fmtDate, todayInTz } from "@/lib/format";
import { commissionProgress } from "@/commissions/statements";
import { CommissionForm } from "@/app/commissions/Forms";
import { DiscountForm } from "./DiscountForm";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ subscriptionId: string }> }) {
  const viewer = await requirePermission("clients.view");
  const money = can(viewer.role, "clients.viewFinancials");
  const { subscriptionId } = await params;

  const snap = await getLiveSnapshot();
  const live = snap.rows.find((r) => r.subscriptionId === subscriptionId);
  if (!live) notFound();
  const r = scopeRow(live, viewer.role);

  const invoices = money ? (await getStripe().invoices.list({ subscription: subscriptionId, limit: 12 })).data : [];
  const client = await db.client.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
  const showCommission = can(viewer.role, "commissions.view") && client !== null;
  const progress = showCommission ? await commissionProgress(client!.id) : null;
  const executives = showCommission ? await db.executive.findMany({ where: { active: true }, orderBy: { name: "asc" } }) : [];
  const currentShares = progress
    ? progress.split.map((s) => ({ executiveId: executives.find((e) => e.name === s.executiveName)?.id ?? "", ratePercent: s.ratePercent }))
    : [];
  const discounts = money && client ? await db.discount.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 5 }) : [];

  return (
    <>
      <PortalHeader showCommissionsLink={can(viewer.role, "commissions.view")} showUsersLink={can(viewer.role, "users.manage")} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2 style={{ marginBottom: 4 }}>{r.name}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          <span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span> · {r.packageName}
          {r.sixMonthContract && " · 6-month contract"} · next charge {fmtDate(r.nextChargeDate)}
          {r.email && <> · {r.email}</>}
        </p>

        {money && (
          <>
            <section className="kpis">
              <div className="kpi"><div className="label">Monthly package</div><div className="value">{formatUsd(r.packageMonthlyCents ?? 0)}</div></div>
              <div className="kpi"><div className="label">Card fee</div><div className="value">{r.cardFeeMonthlyCents ? formatUsd(r.cardFeeMonthlyCents) : "—"}</div></div>
              <div className="kpi"><div className="label">Paying by</div><div className="value small">{r.paymentMethod}</div></div>
              <div className="kpi"><div className="label">Amount due</div><div className="value">{r.amountDueCents ? formatUsd(r.amountDueCents) : "—"}</div></div>
            </section>

            {can(viewer.role, "discounts.apply") && (
              <section className="panel pad">
                <h3>Give a discount</h3>
                <p className="muted">Applies to the next invoices for the number of months you choose, then billing returns to full price. Replaces any current discount.</p>
                <DiscountForm subscriptionId={subscriptionId} />
                {discounts.length > 0 && (
                  <ul className="muted">
                    {discounts.map((d) => (
                      <li key={d.id}>
                        {d.kind === "PERCENT" ? `${d.percentOff}% off` : `${formatUsd(d.amountOffCents ?? 0)} off`} for {d.months} mo — “{d.reason}” · {fmtDate(d.createdAt)}
                        {d.replacedAt && " (replaced)"}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="panel">
              <table>
                <thead>
                  <tr><th>Invoice</th><th>Period</th><th>Status</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Remaining</th></tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>{inv.hosted_invoice_url ? <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">{inv.number ?? inv.id}</a> : inv.number ?? inv.id}</td>
                      <td>{fmtDate(new Date(inv.period_start * 1000))} – {fmtDate(new Date(inv.period_end * 1000))}</td>
                      <td>{inv.status}</td>
                      <td className="num">{formatUsd(inv.total)}</td>
                      <td className="num">{formatUsd(inv.amount_paid)}</td>
                      <td className="num">{inv.amount_remaining ? formatUsd(inv.amount_remaining) : "—"}</td>
                    </tr>
                  ))}
                  {invoices.length === 0 && <tr><td colSpan={6} className="muted">No invoices yet.</td></tr>}
                </tbody>
              </table>
            </section>
          </>
        )}
        {progress && (
          <section className="panel pad" id="commission" style={{ marginTop: 16 }}>
            <h3>Commission</h3>
            <p className="muted">
              {progress.split.length > 0
                ? `Now: ${progress.split.map((s) => `${s.executiveName} ${s.ratePercent}%`).join(" + ")} · `
                : "No commission owner yet · "}
              {progress.earnedMonths} of {progress.windowMonths} paid months earned · {progress.remainingMonths} left
            </p>
            {can(viewer.role, "commissions.markPaid") &&
              (executives.length === 0 ? (
                <p className="muted">Add executives on the <a href="/commissions">Commissions</a> page first.</p>
              ) : (
                <CommissionForm
                  subscriptionId={subscriptionId}
                  executives={executives.map((e) => ({ id: e.id, name: e.name }))}
                  current={currentShares}
                  monthsBeforePortal={client!.commissionMonthsBeforePortal}
                  today={todayInTz()}
                />
              ))}
          </section>
        )}
      </main>
    </>
  );
}
