import type Stripe from "stripe";
import { db } from "@/lib/db";
import { idOf } from "@/stripe/lines";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { ensureClientSubscription } from "@/clients/subscriptions";

/**
 * A client can have several subscriptions (one per package, each on its own billing day). Every one is recorded;
 * the client's status follows their main subscription. When the main one ends while another is still running,
 * that other one becomes the main subscription and the client stays active. The client ends only when all have.
 */
export async function onSubscriptionChanged(sub: Stripe.Subscription, deleted: boolean): Promise<void> {
  const client = await db.client.findUnique({ where: { stripeCustomerId: idOf(sub.customer as string) ?? "" } });
  if (!client) return;
  const ended = deleted || sub.status === "canceled" || sub.status === "incomplete_expired";
  const endedAt = ended ? new Date((sub.ended_at ?? Math.floor(Date.now() / 1000)) * 1000) : null;

  const row = await ensureClientSubscription(client.id, sub.id);
  await db.clientSubscription.update({ where: { id: row.id }, data: { status: sub.status, endedAt } });

  const isMain = !client.stripeSubscriptionId || client.stripeSubscriptionId === sub.id;
  if (isMain && ended) {
    const next = await db.clientSubscription.findFirst({
      where: { clientId: client.id, endedAt: null, stripeSubscriptionId: { not: sub.id } },
      orderBy: { createdAt: "asc" },
    });
    if (next) {
      // Another package is still running: it becomes the main one and the client stays active.
      await db.client.update({
        where: { id: client.id },
        data: { stripeSubscriptionId: next.stripeSubscriptionId, subscriptionStatus: next.status, endedAt: null, ...(next.packageId ? { packageId: next.packageId } : {}) },
      });
      await refreshClientStatus(client.id);
      return;
    }
  }
  if (isMain) {
    await db.client.update({ where: { id: client.id }, data: { stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, endedAt } });
  } else if (!ended && client.endedAt) {
    // A new package for a client whose earlier subscription had ended: they're a client again, on this one.
    await db.client.update({ where: { id: client.id }, data: { stripeSubscriptionId: sub.id, subscriptionStatus: sub.status, endedAt: null } });
  }
  await refreshClientStatus(client.id);
}
