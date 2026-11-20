import type Stripe from "stripe";
import { db } from "@/lib/db";
import { idOf } from "@/stripe/lines";
import { refreshClientStatus } from "@/stripe/clientStatusSync";

export async function onSubscriptionChanged(sub: Stripe.Subscription, deleted: boolean): Promise<void> {
  const client = await db.client.findUnique({ where: { stripeCustomerId: idOf(sub.customer as string) ?? "" } });
  if (!client) return;
  // Only track the subscription the client is linked to (or link it if none yet).
  if (client.stripeSubscriptionId && client.stripeSubscriptionId !== sub.id) return;
  const ended = deleted || sub.status === "canceled" || sub.status === "incomplete_expired";
  await db.client.update({
    where: { id: client.id },
    data: {
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      endedAt: ended ? new Date((sub.ended_at ?? Math.floor(Date.now() / 1000)) * 1000) : null,
    },
  });
  await refreshClientStatus(client.id);
}
