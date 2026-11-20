import { notFound } from "next/navigation";
import type { Role } from "@prisma/client";
import { can } from "@/auth/permissions";
import { db } from "@/lib/db";
import { STATUS_LABEL } from "@/domain/clientStatus";
import { formatUsd } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { CommissionSection } from "./CommissionSection";
import { refreshClientStatus } from "@/stripe/clientStatusSync";

/** Page for a client that has no Stripe subscription yet (e.g. a new ACE client), addressed by portal id. */
export async function PortalClientPage({ clientId, viewer }: { clientId: string; viewer: { name: string; role: Role } }) {
  if (!(await db.client.findUnique({ where: { id: clientId }, select: { id: true } }))) notFound();
  await refreshClientStatus(clientId);
  const client = (await db.client.findUnique({ where: { id: clientId } }))!;
  const pkg = client.packageId ? await db.package.findUnique({ where: { id: client.packageId } }) : null;
  const slot = client.aceSlotId ? await db.aceSlot.findUnique({ where: { id: client.aceSlotId } }) : null;
  const ace = can(viewer.role, "ace.manage");
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2 style={{ marginBottom: 4 }}>{client.name}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          <span className={`badge s-${client.status}`}>{STATUS_LABEL[client.status]}</span>
          {pkg && <> · {pkg.name}{slot?.customMonthlyCents && can(viewer.role, "clients.viewFinancials") ? ` (${formatUsd(slot.customMonthlyCents)}/mo)` : ""}</>}
          {client.type === "ACE" && client.acePrepaidUntil && <> · Prepaid by ACE until {fmtDate(client.acePrepaidUntil)}</>}
          {client.continuationDecision === "CONTINUING" && " · continuing after month 6"}
          {client.continuationDecision === "ENDING" && " · not continuing after month 6"}
          {client.email && can(viewer.role, "clients.viewFinancials") && <> · {client.email}</>}
        </p>
        {ace && slot && <p><a href={`/ace/${slot.batchId}`}>Open the ACE batch</a></p>}
        <CommissionSection clientId={client.id} formKey={client.id} role={viewer.role} />
      </main>
    </>
  );
}
