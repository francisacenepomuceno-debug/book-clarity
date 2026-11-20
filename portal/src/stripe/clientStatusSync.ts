import type { ClientStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { deriveClientStatus } from "@/domain/clientStatus";

/** Recomputes and stores a client's status from what the portal knows. */
export async function refreshClientStatus(clientId: string, now: Date = new Date()): Promise<ClientStatus> {
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const latest = await db.invoice.findFirst({
    where: { clientId, kind: "SUBSCRIPTION" },
    orderBy: [{ periodEnd: "desc" }, { id: "desc" }],
  });
  const status = deriveClientStatus({
    type: c.type,
    endedAt: c.endedAt,
    paused: c.subscriptionStatus === "paused",
    // Until onboarding records exist (Plan 4), having a subscription means onboarding is done.
    onboardingComplete: c.stripeSubscriptionId !== null || c.status !== "ONBOARDING",
    acePrepaidUntil: null, // Plan 3
    continuingAwaitingPm: false, // Plan 3
    latestInvoice: latest
      ? { status: latest.status as "open", firstFailedAt: latest.firstFailedAt }
      : null,
    now,
  });
  if (status !== c.status) await db.client.update({ where: { id: clientId }, data: { status } });
  return status;
}
