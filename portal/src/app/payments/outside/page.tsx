import { requirePermission } from "@/auth/permissions";
import { PortalHeader } from "@/app/PortalHeader";
import { outsideBills, OUTSIDE_METHODS } from "@/billing/outsidePayments";
import { db } from "@/lib/db";
import { formatUsd } from "@/lib/money";
import { fmtDate, todayInTz } from "@/lib/format";
import { MarkPaidOutsideForm } from "./Forms";

export const dynamic = "force-dynamic";

const STATE = { upcoming: "Upcoming", due: "Due today", overdue: "Overdue" } as const;
const BADGE = { upcoming: "s-CURRENT", due: "s-PAST_DUE", overdue: "s-AT_RISK" } as const;

export default async function OutsidePaymentsPage() {
  const viewer = await requirePermission("discounts.apply");
  const now = new Date();
  let bills: Awaited<ReturnType<typeof outsideBills>> = [];
  let stripeError = false;
  try {
    bills = await outsideBills(now);
  } catch {
    stripeError = true;
  }
  const clients = await db.client.findMany({ where: { paysOutsideStripe: true, endedAt: null }, orderBy: { name: "asc" } });
  const recent = await db.invoice.findMany({ where: { paidOutsideAt: { not: null } }, include: { client: true }, orderBy: { paidOutsideAt: "desc" }, take: 20 });
  const today = todayInTz();
  const when = (d: number) => (d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/payments">← Payments</a></p>
        <h2>Payments outside Stripe</h2>
        <p className="muted">
          Clients who pay by Zelle, check, PayPal, bill.com, wire or cash. Stripe still sets their billing dates and amounts. The Super Admin is reminded by email and here 7 days before, 1 day before and on each due date. When a payment arrives, mark it paid: Stripe shows the bill as paid (no charge is made), and reports and commission include it.
        </p>
        {stripeError && <div className="error">Couldn&apos;t load upcoming bills from Stripe. Refresh in a minute.</div>}
        <section className="panel">
          <table>
            <thead>
              <tr><th>Client</th><th>Paid by</th><th>Due</th><th>Status</th><th className="num">Amount</th><th>Record the payment</th></tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={`${b.clientId}-${b.invoiceId ?? "next"}-${b.dueOn.toISOString()}`}>
                  <td><a href={b.clientHref}>{b.clientName}</a></td>
                  <td>{b.method ?? "—"}</td>
                  <td>{fmtDate(b.dueOn)} <span className="muted">· {when(b.daysUntil)}</span></td>
                  <td><span className={`badge ${BADGE[b.state]}`}>{STATE[b.state]}</span></td>
                  <td className="num">{formatUsd(b.amountCents)}</td>
                  <td>{b.invoiceId ? <MarkPaidOutsideForm invoiceId={b.invoiceId} method={b.method} methods={OUTSIDE_METHODS} today={today} /> : <span className="muted">Stripe issues the bill on its billing date</span>}</td>
                </tr>
              ))}
              {bills.length === 0 && <tr><td colSpan={6} className="muted">Nothing due. {clients.length === 0 && "No client is set to pay outside Stripe yet: open a client and tick “Pays outside Stripe”."}</td></tr>}
            </tbody>
          </table>
        </section>
        {clients.length > 0 && <p className="muted">Paying outside Stripe: {clients.map((c) => `${c.name}${c.outsidePaymentMethod ? ` (${c.outsidePaymentMethod})` : ""}`).join(", ")}</p>}
        {recent.length > 0 && (
          <section className="panel" style={{ marginTop: 16 }}>
            <table>
              <thead><tr><th>Recently recorded</th><th>Paid on</th><th>Paid by</th><th>Reference</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}><td>{r.client?.name}</td><td>{fmtDate(r.paidOutsideAt)}</td><td>{r.outsideMethod}</td><td>{r.outsideReference ?? "—"}</td><td className="num">{formatUsd(r.amountPaidCents)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  );
}
