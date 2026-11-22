import type { Role } from "@prisma/client";
import { can } from "@/auth/permissions";
import { commissionProgress } from "@/commissions/statements";
import { db } from "@/lib/db";
import { todayInTz } from "@/lib/format";
import { CommissionForm } from "@/app/commissions/Forms";

/** Commission owner/split and progress for one client (Owners and Super Admin only). */
export async function CommissionSection({ clientId, formKey, role }: { clientId: string; formKey: string; role: Role }) {
  if (!can(role, "commissions.view")) return null;
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const progress = await commissionProgress(clientId);
  const executives = await db.executive.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const current = progress.split.map((s) => ({ executiveId: executives.find((e) => e.name === s.executiveName)?.id ?? "", ratePercent: s.ratePercent }));
  return (
    <section className="panel pad" id="commission" style={{ marginTop: 16 }}>
      <h3>Commission</h3>
      <p className="muted">
        {progress.split.length > 0 ? `Now: ${progress.split.map((s) => `${s.executiveName} ${s.ratePercent}%`).join(" + ")} · ` : "No commission owner yet · "}
        {client.type === "ACE" ? "ACE months 1–6 paid as a lump sum when the batch is paid · " : ""}
        {progress.otherPackages.length > 0 && <>{progress.mainPackageName ?? "Main package"}: </>}
        {progress.earnedMonths} of {progress.windowMonths} paid {client.type === "ACE" ? "autopay months (7–12)" : "months"} earned · {progress.remainingMonths} left
      </p>
      {progress.otherPackages.length > 0 && (
        <ul className="plain muted">
          {progress.otherPackages.map((o) => (
            <li key={o.subscriptionId}>
              {o.packageName} (its own window): {o.earnedMonths} of {o.windowMonths} paid months earned · {o.remainingMonths} left{o.ended ? " · ended" : ""}
            </li>
          ))}
        </ul>
      )}
      {can(role, "commissions.markPaid") &&
        (executives.length === 0 ? (
          <p className="muted">Add executives on the <a href="/commissions">Commissions</a> page first.</p>
        ) : (
          <CommissionForm subscriptionId={formKey} executives={executives.map((e) => ({ id: e.id, name: e.name }))} current={current} monthsBeforePortal={client.commissionMonthsBeforePortal} today={todayInTz()} />
        ))}
    </section>
  );
}
