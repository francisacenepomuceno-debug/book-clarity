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
    // An end date in the future (an ACE client who won't continue) takes effect when it arrives.
    endedAt: c.endedAt && c.endedAt <= now ? c.endedAt : null,
    paused: c.subscriptionStatus === "paused",
    // ACE clients are onboarded on their slot start date; others once they have a subscription (until Plan 4).
    onboardingComplete: c.stripeSubscriptionId !== null || c.aceSlotId !== null || c.status !== "ONBOARDING",
    acePrepaidUntil: c.acePrepaidUntil,
    continuingAwaitingPm: c.continuationDecision === "CONTINUING" && c.stripeSubscriptionId === null,
    latestInvoice: latest
      ? { status: latest.status as "open", firstFailedAt: latest.firstFailedAt }
      : null,
    now,
  });
  if (status !== c.status) await db.client.update({ where: { id: clientId }, data: { status } });
  return status;
}
