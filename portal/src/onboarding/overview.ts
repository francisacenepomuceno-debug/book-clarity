import { db } from "@/lib/db";
import { nextStep, type OnboardingStep } from "@/domain/onboarding";
import { onboardingLink } from "@/onboarding/start";

export type OnboardingRow = {
  onboardingId: string;
  clientId: string;
  name: string;
  /** The contact person, when a company name is set (name is then the company). */
  contactName: string | null;
  email: string | null;
  type: "DIRECT" | "ACE";
  packageName: string | null;
  step: OnboardingStep;
  startedAt: Date;
  lastProgressAt: Date;
  callBookedAt: Date | null;
  callStartsAt: Date | null;
  callStatus: string | null;
  signedAt: Date | null;
  countersignedAt: Date | null;
  link: string;
  /** Onboarding fee not yet paid or under way (an Owner can still waive it). */
  feeWaivable: boolean;
  feeCents: number | null;
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
    name: o.client.companyName || o.client.name,
    contactName: o.client.companyName ? o.client.name : null,
    email: o.client.email,
    type: o.client.type,
    packageName: o.client.package?.name ?? null,
    step: nextStep(o, o.client.type),
    startedAt: o.createdAt,
    lastProgressAt: o.lastProgressAt,
    callBookedAt: o.callBookedAt,
    callStartsAt: o.callStartsAt,
    callStatus: o.callStatus,
    signedAt: o.signedAt,
    countersignedAt: o.countersignedAt,
    link: onboardingLink(o.id),
    feeCents: o.onboardingFeeCents,
    feeWaivable: o.client.type === "DIRECT" && !o.feePaidAt && !o.feeSubmittedAt && !o.feeInvoiceId && !o.completedAt && (o.onboardingFeeCents ?? 1) > 0,
  }));
}
