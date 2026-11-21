import type { Role } from "@prisma/client";
import { can } from "@/auth/permissions";
import { db } from "@/lib/db";
import { nextStep, STEP_LABEL } from "@/domain/onboarding";
import { fmtDate } from "@/lib/format";

/** Onboarding progress, agreement and questionnaire answers for staff. */
export async function OnboardingSection({ clientId, role }: { clientId: string; role: Role }) {
  const o = await db.onboarding.findUnique({ where: { clientId }, include: { client: true } });
  if (!o || !can(role, "onboarding.view")) return null;
  const step = nextStep(o, o.client.type);
  const intake = (o.intake ?? []) as { question: string; answer: string }[];
  return (
    <section className="panel pad">
      <h3>Onboarding</h3>
      <p>
        {step === "done" ? <>Done. Call booked {fmtDate(o.callBookedAt)}.</> : <>Current step: {STEP_LABEL[step]}.</>}
        {o.signedAt && <> · Agreement signed {fmtDate(o.signedAt)} by {o.signerName}{o.countersignedAt ? ", countersigned" : ", awaiting countersignature"}{can(role, "ace.manage") && <> (<a href={`/contracts/${o.id}`}>view</a>{o.countersignedAt && <> · <a href={`/contracts/${o.id}/pdf`}>download PDF</a></>})</>}</>}
        {o.feePaidAt && <> · Onboarding fee paid {fmtDate(o.feePaidAt)}</>}
        {o.quickbooks && <> · QuickBooks: {o.quickbooks}</>}
      </p>
      {intake.length > 0 && (
        <details>
          <summary>Questionnaire answers ({fmtDate(o.intakeAt)})</summary>
          <dl className="answers">
            {intake.map((a, i) => (
              <div key={i}><dt>{a.question}</dt><dd>{a.answer || <span className="muted">—</span>}</dd></div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}
