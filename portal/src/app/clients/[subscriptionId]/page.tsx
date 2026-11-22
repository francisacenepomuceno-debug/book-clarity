import { notFound } from "next/navigation";
import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { getStripe } from "@/stripe/client";
import { can, requirePermission } from "@/auth/permissions";
import { scopeRow, withPricing } from "@/clients/queries";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { db } from "@/lib/db";
import { PortalHeader } from "@/app/PortalHeader";
import { fmtDate, } from "@/lib/format";
import { CommissionSection } from "./CommissionSection";
import { OnboardingSection } from "./OnboardingSection";
import { SuspensionSection } from "./SuspensionSection";
import { PortalClientPage } from "./PortalClientPage";
import { DiscountForm } from "./DiscountForm";
import { subscriptionRef, subscriptionsOf } from "@/clients/subscriptions";
import { LinkPackageForm, MakeMainButton, RevertPriceButton } from "./PriceSection";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ subscriptionId: string }> }) {
  const viewer = await requirePermission("clients.view");
  const money = can(viewer.role, "clients.viewFinancials");
  const { subscriptionId } = await params;
  if (!subscriptionId.startsWith("sub_")) return <PortalClientPage clientId={subscriptionId} viewer={viewer} />;

  const snap = await getLiveSnapshot();
  const live = snap.rows.find((r) => r.subscriptionId === subscriptionId);
  if (!live) notFound();
  const r = scopeRow((await withPricing([live]))[0], viewer.role);

  const invoices = money ? (await getStripe().invoices.list({ subscription: subscriptionId, limit: 12 })).data : [];
  // A client can pay for several packages, each its own subscription; this page is for one of them.
  const ref = await subscriptionRef(subscriptionId);
  const client = ref?.client ?? null;
  const canLink = can(viewer.role, "ace.manage");
  const packages = canLink ? await db.package.findMany({ orderBy: { name: "asc" } }) : [];
  const linked = ref?.package ?? null;
  const otherSubs = client ? (await subscriptionsOf(client)).filter((s) => s.subscriptionId !== subscriptionId && !s.endedAt) : [];
  const otherNames = new Map((await db.package.findMany({ where: { id: { in: otherSubs.flatMap((s) => (s.packageId ? [s.packageId] : [])) } } })).map((p) => [p.id, p.name]));
  const discounts = money && client ? await db.discount.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 5 }) : [];

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2 style={{ marginBottom: 4 }}>{r.name}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          <span className={`badge s-${r.status}`}>{STATUS_LABEL[r.status]}</span> · {r.packageName}
          {r.sixMonthContract && " · 6-month contract"} · next charge {fmtDate(r.nextChargeDate)}
          {r.email && <> · {r.email}</>}
        </p>
        {ref && (!ref.isMain || otherSubs.length > 0) && (
          <p className="muted">
            {ref.isMain ? "Main package." : "An additional package, billed on its own schedule."}
            {otherSubs.length > 0 && (
              <>
                {" "}Also pays for:{" "}
                {otherSubs.map((s, i) => (
                  <span key={s.subscriptionId}>
                    {i > 0 && ", "}
                    <a href={`/clients/${s.subscriptionId}`}>{(s.packageId && otherNames.get(s.packageId)) || s.productName || "another package"}</a>
                    {s.isMain && " (main)"}
                  </span>
                ))}
              </>
            )}
          </p>
        )}

        {money && (
          <>
            <section className="kpis">
              <div className="kpi"><div className="label">Monthly package</div><div className="value">{formatUsd(r.packageMonthlyCents ?? 0)}</div></div>
              <div className="kpi"><div className="label">Card fee</div><div className="value">{r.cardFeeMonthlyCents ? formatUsd(r.cardFeeMonthlyCents) : "—"}</div></div>
              <div className="kpi"><div className="label">Paying by</div><div className="value small">{r.paymentMethod}</div></div>
              <div className="kpi"><div className="label">Amount due</div><div className="value">{r.amountDueCents ? formatUsd(r.amountDueCents) : "—"}</div></div>
            </section>

            {canLink && client && (
              <section className="panel pad" id="price">
                <h3>Package and price</h3>
                {ref && !ref.isMain && <MakeMainButton clientId={client.id} subscriptionId={subscriptionId} />}
                <LinkPackageForm
                  clientId={client.id}
                  subscriptionId={subscriptionId}
                  packageId={ref?.packageId ?? null}
                  packages={packages.map((x) => ({ id: x.id, label: x.isCustom ? `${x.name} (Custom)` : `${x.name} · ${formatUsd(x.monthlyPriceCents)}/mo` }))}
                />
                {r.discounted ? (
                  <>
                    <p>
                      <strong className="discounted">Discounted.</strong> Paying {formatUsd(r.packageMonthlyCents ?? 0)}/month
                      {r.listPriceCents ? <> instead of the {linked?.name} list price of {formatUsd(r.listPriceCents)}</> : null}
                      {r.hasDiscount && <> · a Stripe discount is applied</>}.
                    </p>
                    {can(viewer.role, "discounts.apply") && linked && !linked.isCustom && (
                      <RevertPriceButton
                        clientId={client.id}
                        subscriptionId={subscriptionId}
                        confirmText={`Put ${r.name} back on ${linked.name} at ${formatUsd(linked.monthlyPriceCents)}/month? Any discount is removed. Nothing is charged now: the new price starts with the next bill${r.nextChargeDate ? ` (${fmtDate(r.nextChargeDate)})` : ""}.`}
                      />
                    )}
                    {!linked && <p className="muted">Link the package above to see the original price and revert to it.</p>}
                  </>
                ) : (
                  <p className="muted">{linked ? (linked.isCustom ? "Custom package: no list price to compare." : `Paying the ${linked.name} list price.`) : "Not linked to a package yet."}</p>
                )}
              </section>
            )}

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
        {client?.type === "ACE" && client.acePrepaidUntil && (
          <p className="muted">ACE client · prepaid until {fmtDate(client.acePrepaidUntil)}</p>
        )}
        {client && <SuspensionSection clientId={client.id} role={viewer.role} />}
        {client && <OnboardingSection clientId={client.id} role={viewer.role} />}
        {client && <CommissionSection clientId={client.id} formKey={subscriptionId} role={viewer.role} />}
      </main>
    </>
  );
}
