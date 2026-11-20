import { db } from "@/lib/db";
import { contractPreview, intakeQuestions, loadOnboarding, type Details } from "@/onboarding/steps";
import { renderContract } from "@/domain/contract";
import { getOnboardingSettings } from "@/settings/onboarding";
import { STEP_LABEL, type OnboardingStep } from "@/domain/onboarding";
import { formatUsd } from "@/lib/money";
import { CallStep, DetailsStep, IntakeStep, PackageStep, SignStep } from "./Steps";
import { PaymentStep } from "./PaymentStep";

export const dynamic = "force-dynamic";

const ORDER: OnboardingStep[] = ["package", "details", "contract", "payment", "intake", "call"];

function Shell({ children, step, ace }: { children: React.ReactNode; step?: OnboardingStep; ace?: boolean }) {
  const steps = ORDER.filter((s) => !(ace && (s === "package" || s === "payment")));
  return (
    <main className="auth">
      <div className="card wide">
        <h1>Welcome to Book Clarity</h1>
        {step && <p className="muted">Step {steps.indexOf(step) + 1} of {steps.length}: {STEP_LABEL[step]}</p>}
        {children}
      </div>
    </main>
  );
}

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const l = await loadOnboarding(token);
  if ("error" in l) return <Shell><p>{l.error}</p></Shell>;
  const ace = l.client.type === "ACE";
  const s = l.step;

  if (s === "package") {
    const packages = await db.package.findMany({ where: { active: true, isCustom: false }, orderBy: { monthlyPriceCents: "asc" } });
    return (
      <Shell step={s} ace={ace}>
        <p>Choose your bookkeeping package:</p>
        <PackageStep token={token} packages={packages.map((p) => ({ id: p.id, name: p.name, monthly: formatUsd(p.monthlyPriceCents), fee: formatUsd(p.onboardingFeeCents) }))} />
      </Shell>
    );
  }
  if (s === "details") {
    return (
      <Shell step={s} ace={ace}>
        <p>{l.pkg ? <>Package: <strong>{l.pkg.name}</strong>. </> : null}Tell us about your business. These details go on your agreement.</p>
        <DetailsStep token={token} initial={{ business: l.client.name, phone: l.client.phone ?? "", ...((l.onboarding.details ?? {}) as Partial<Details>) } as Record<string, string>} />
      </Shell>
    );
  }
  if (s === "contract") {
    const p = await contractPreview(l);
    if (!p) return <Shell step={s} ace={ace}><p>Your agreement isn't ready yet. Please contact Book Clarity.</p></Shell>;
    const { text } = renderContract(p.template, p.values);
    return (
      <Shell step={s} ace={ace}>
        <p>Please read your agreement, then sign at the bottom.</p>
        <pre className="contract">{text}</pre>
        <SignStep token={token} signerName={p.values.signer_name} quickbooksOptions={p.quickbooksOptions} />
      </Shell>
    );
  }
  if (s === "payment") {
    return (
      <Shell step={s} ace={ace}>
        <PaymentStep token={token} />
      </Shell>
    );
  }
  if (s === "intake") {
    return (
      <Shell step={s} ace={ace}>
        <p>A few questions so we can prepare for your onboarding call.</p>
        <IntakeStep token={token} questions={await intakeQuestions()} />
      </Shell>
    );
  }
  return (
    <Shell step={s} ace={ace}>
      <p>Last step: book your onboarding call.</p>
      <CallStep token={token} calendarUrl={(await getOnboardingSettings()).calendarUrl} />
    </Shell>
  );
}
