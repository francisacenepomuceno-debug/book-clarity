import type { Role } from "@prisma/client";
import { can } from "@/auth/permissions";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { ResumeButton } from "./ResumeButton";

/** Shown while a client is suspended for non-payment. Owners can resume them by hand. */
export async function SuspensionSection({ clientId, role }: { clientId: string; role: Role }) {
  const c = await db.client.findUnique({ where: { id: clientId }, select: { suspendedAt: true } });
  if (!c?.suspendedAt) return null;
  return (
    <section className="panel pad">
      <h3 className="s-SUSPENDED">Suspended since {fmtDate(c.suspendedAt)}</h3>
      <p>Billing is paused for non-payment (no late fees). It resumes automatically when the outstanding payment goes through.</p>
      {can(role, "ace.manage") && <ResumeButton clientId={clientId} />}
    </section>
  );
}
