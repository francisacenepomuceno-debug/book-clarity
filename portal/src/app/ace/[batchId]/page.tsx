import { notFound } from "next/navigation";
import { requirePermission } from "@/auth/permissions";
import { batchDetail } from "@/ace/batches";
import { listPackages } from "@/packages/packages";
import { db } from "@/lib/db";
import { formatUsd } from "@/lib/money";
import { fmtDate, todayInTz } from "@/lib/format";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { PortalHeader } from "@/app/PortalHeader";
import { AssignSlotForm, CardPayLinkForm, DeleteBatchForm, RecordPaymentForm, ResendInvoiceForm } from "../Forms";

export const dynamic = "force-dynamic";

export default async function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const viewer = await requirePermission("ace.manage");
  const { batchId } = await params;
  const batch = await batchDetail(batchId);
  if (!batch) notFound();
  const [slots, packages, candidates] = await Promise.all([
    db.aceSlot.findMany({ where: { batchId }, orderBy: [{ packageId: "asc" }, { id: "asc" }] }),
    listPackages(),
    db.client.findMany({ where: { aceSlotId: null, endedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const clients = await db.client.findMany({ where: { id: { in: slots.flatMap((s) => (s.clientId ? [s.clientId] : [])) } } });
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const pkgName = new Map(packages.map((p) => [p.id, p.name]));
  const today = todayInTz();

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/ace">← ACE batches</a></p>
        <h2>ACE batch · {fmtDate(batch.purchasedAt)}</h2>
        <p className="muted">
          {formatUsd(batch.totalCents)} ·{" "}
          {batch.paidAt
            ? `Paid ${fmtDate(batch.paidAt)} (${batch.paidVia === "STRIPE" ? "through Stripe" : batch.paymentMethod}${batch.paymentReference ? `, ${batch.paymentReference}` : ""})`
            : batch.invoiceSentAt ? `Invoice sent to ACE ${fmtDate(batch.invoiceSentAt)}, not paid yet` : batch.stripeInvoiceId ? "Invoice not fully sent" : "Not paid yet"}
          {batch.note && ` · ${batch.note}`}
        </p>
        {!batch.stripeInvoiceId && slots.every((x) => !x.clientId) && (
          <section className="panel pad">
            <h3>Entered by mistake?</h3>
            <p className="muted">While no client is in its slots, you can delete this batch and enter it again. Any commission it posted is removed too.</p>
            <DeleteBatchForm batchId={batchId} />
          </section>
        )}
        {batch.commission && (
          <p className="muted">
            <strong>Commission:</strong> {batch.commission.executiveName} earns {batch.commission.rateBp / 100}% of each slot&apos;s price less the onboarding fee, posted when ACE pays, whether or not the slot has a client.
          </p>
        )}
        {batch.historical && (
          <p className="muted"><strong>Historical batch</strong> (bought before the portal): no months 1–6 commission is posted for its clients, because it was settled outside the portal.</p>
        )}

        {!batch.paidAt && !batch.invoiceSentAt && batch.stripeInvoiceId && (
          <section className="panel pad">
            <h3>ACE's invoice wasn't fully sent</h3>
            <p className="muted">Stripe had a problem while sending it. Try again; nothing is duplicated.</p>
            <ResendInvoiceForm batchId={batchId} />
          </section>
        )}
        {!batch.paidAt && batch.stripeInvoiceId && (
          <section className="panel pad">
            <h3>Payment link for ACE</h3>
            <p className="muted">ACE chooses bank (ACH, no fee) or card. Paying by credit card adds the 3% fee automatically (when the card fee is on); debit cards have no fee. Choosing card reissues the invoice and cancels the ACH one, so ACE can't pay twice.</p>
            <CardPayLinkForm batchId={batchId} />
          </section>
        )}
        {!batch.paidAt && (
          <section className="panel pad">
            <h3>Record payment received</h3>
            <p className="muted">For a check or bank transfer. Commission on filled slots posts once the batch is paid.</p>
            <RecordPaymentForm batchId={batchId} today={today} />
          </section>
        )}

        <section className="panel pad" style={{ marginTop: 16 }}>
          <h3>Assign a client to a slot</h3>
          {batch.packages.every((p) => p.open === 0) ? (
            <p className="muted">Every slot in this batch is filled.</p>
          ) : (
            <AssignSlotForm
              batchId={batchId}
              packages={batch.packages.map((p) => ({ id: p.packageId, name: p.name, open: p.open, isCustom: packages.find((x) => x.id === p.packageId)?.isCustom ?? false }))}
              clients={candidates}
              today={today}
            />
          )}
        </section>

        <section className="panel" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th>Package</th><th>Client</th><th>Status</th><th>Start</th><th>Prepaid until</th></tr></thead>
            <tbody>
              {slots.map((s) => {
                const c = s.clientId ? clientById.get(s.clientId) : null;
                return (
                  <tr key={s.id}>
                    <td>{pkgName.get(s.packageId)}{s.customMonthlyCents ? <span className="muted"> · {formatUsd(s.customMonthlyCents)}/mo</span> : null}</td>
                    <td>{c ? <a href={`/clients/${c.id}`}>{c.name}</a> : <span className="muted">Open</span>}</td>
                    <td>{c ? <span className={`badge s-${c.status}`}>{STATUS_LABEL[c.status]}</span> : ""}</td>
                    <td>{fmtDate(s.startDate)}</td>
                    <td>{fmtDate(s.prepaidUntil)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
