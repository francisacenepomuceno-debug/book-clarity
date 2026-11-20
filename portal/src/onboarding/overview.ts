import { db } from "@/lib/db";
import { nextStep, type OnboardingStep } from "@/domain/onboarding";
import { onboardingLink } from "@/onboarding/start";

export type OnboardingRow = {
  onboardingId: string;
  clientId: string;
  name: string;
  email: string | null;
  type: "DIRECT" | "ACE";
  packageName: string | null;
  step: OnboardingStep;
  startedAt: Date;
  lastProgressAt: Date;
  callBookedAt: Date | null;
  signedAt: Date | null;
  countersignedAt: Date | null;
  link: string;
};

/** Staff view: every onboarding, newest first, with its current step. Ended clients are left out. */
export async function listOnboardings(): Promise<OnboardingRow[]> {
  const rows = await db.onboarding.findMany({
    where: { client: { endedAt: null } },
    include: { client: { include: { package: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((o) => ({
    onboardingId: o.id,
    clientId: o.clientId,
    name: o.client.name,
    email: o.client.email,
    type: o.client.type,
    packageName: o.client.package?.name ?? null,
    step: nextStep(o, o.client.type),
    startedAt: o.createdAt,
    lastProgressAt: o.lastProgressAt,
    callBookedAt: o.callBookedAt,
    signedAt: o.signedAt,
    countersignedAt: o.countersignedAt,
    link: onboardingLink(o.id),
  }));
}
