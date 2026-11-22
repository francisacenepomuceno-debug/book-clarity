import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { subscriptionIdOf } from "@/stripe/lines";

/**
 * Invoices stored before the portal recorded which subscription they bill have none. That only matters for clients
 * who pay for more than one package (each package has its own commission window), so for those clients this reads
 * the subscription from Stripe and fills it in. Read-only towards Stripe; safe to run repeatedly.
 */
export async function fillInvoiceSubscriptions(limit = 300, client?: Stripe): Promise<number> {
  const multi = await db.clientSubscription.groupBy({ by: ["clientId"], _count: { _all: true }, having: { clientId: { _count: { gt: 1 } } } });
  if (!multi.length) return 0;
  const missing = await db.invoice.findMany({
    where: { clientId: { in: multi.map((m) => m.clientId) }, stripeSubscriptionId: null, kind: "SUBSCRIPTION" },
    select: { id: true, stripeInvoiceId: true },
    take: limit,
  });
  if (!missing.length) return 0;
  const stripe = client ?? getStripe();
  let filled = 0;
  for (const inv of missing) {
    try {
      const sub = subscriptionIdOf(await stripe.invoices.retrieve(inv.stripeInvoiceId));
      if (sub) {
        await db.invoice.update({ where: { id: inv.id }, data: { stripeSubscriptionId: sub } });
        filled++;
      }
    } catch (e) {
      console.error(`[invoice-subscriptions] ${inv.stripeInvoiceId}:`, (e as Error).message);
    }
  }
  return filled;
}
