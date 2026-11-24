import type { Role } from "@prisma/client";
import { can } from "@/auth/permissions";
import { db } from "@/lib/db";
import { nextStep, stepLabel } from "@/domain/onboarding";
import { fmtDate, fmtDateTime } from "@/lib/format";

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
        {step === "done" ? <>Done.</> : <>Current step: {stepLabel(step, o.onboardingFeeCents === 0)}.</>}
        {o.callStatus === "booked" && o.callStartsAt ? <> · Onboarding call: <strong>{fmtDateTime(o.callStartsAt)}</strong> (GHL calendar)</>
          : o.callStatus === "cancelled" ? <> · <span className="badge AT_RISK">Onboarding call cancelled</span> needs rebooking</>
          : o.callBookedAt ? <> · Call booked (confirmed by the client {fmtDate(o.callBookedAt)})</> : null}
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
