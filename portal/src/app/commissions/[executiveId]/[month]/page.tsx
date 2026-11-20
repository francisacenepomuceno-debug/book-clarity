import { notFound } from "next/navigation";
import { can, requirePermission } from "@/auth/permissions";
import { statementLines, listStatements } from "@/commissions/statements";
import { formatUsd } from "@/lib/money";
import { fmtDate, fmtMonth } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";

export const dynamic = "force-dynamic";

export default async function StatementPage({ params }: { params: Promise<{ executiveId: string; month: string }> }) {
  const viewer = await requirePermission("commissions.view");
  const { executiveId, month } = await params;
  const summary = (await listStatements()).find((s) => s.executiveId === executiveId && s.month === month);
  if (!summary) notFound();
  const lines = await statementLines(executiveId, month);

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/commissions">← Commissions</a></p>
        <h2>{summary.executiveName} · {fmtMonth(month)}</h2>
        <p className="muted">
          {summary.status === "PAID" ? `Paid ${fmtDate(summary.paidAt)} · locked` : "Not paid yet"} · total {formatUsd(summary.totalCents)}
        </p>
        <section className="panel">
          <table>
            <thead>
              <tr><th>Date</th><th>Client</th><th>Type</th><th>Paid month</th><th className="num">Base</th><th className="num">Rate</th><th className="num">Commission</th></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>{fmtDate(l.occurredAt)}</td>
                  <td>{l.clientName}</td>
                  <td>{l.kind === "EARNED" ? "Payment" : l.kind === "ACE_PREPAID" ? "ACE months 1–6" : "Refund (clawback)"}</td>
                  <td>{l.kind === "ACE_PREPAID" ? "1–6" : l.windowIndex ? `${l.windowIndex} of ${l.windowMonths}` : "—"}</td>
                  <td className="num">{formatUsd(l.baseCents)}</td>
                  <td className="num">{l.rateBp / 100}%</td>
                  <td className="num">{formatUsd(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
