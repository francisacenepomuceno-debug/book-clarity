export type OnboardingStep = "package" | "details" | "contract" | "payment" | "intake" | "call" | "done";

export const STEP_LABEL: Record<OnboardingStep, string> = {
  package: "Choosing a package",
  details: "Entering details",
  contract: "Signing the contract",
  payment: "Paying the onboarding fee",
  intake: "Filling in the questionnaire",
  call: "Booking the onboarding call",
  done: "Done",
};

type Progress = {
  packageId: string | null;
  details: unknown;
  signedAt: Date | null;
  feePaidAt: Date | null;
  intakeAt: Date | null;
  callBookedAt: Date | null;
  completedAt: Date | null;
};

/** Pure: the client's next onboarding step. ACE clients skip the package choice and the payment (ACE paid). */
export function nextStep(o: Progress, type: "DIRECT" | "ACE"): OnboardingStep {
  if (o.completedAt) return "done";
  if (type === "DIRECT" && !o.packageId) return "package";
  if (o.details == null) return "details";
  if (!o.signedAt) return "contract";
  if (type === "DIRECT" && !o.feePaidAt) return "payment";
  if (!o.intakeAt) return "intake";
  if (!o.callBookedAt) return "call";
  return "done";
}
