import type Stripe from "stripe";
import { db } from "@/lib/db";
import { upsertInvoiceFromStripe } from "@/stripe/handlers/invoice";
import { getPaidMethod } from "@/stripe/deps";
import { idOf } from "@/stripe/lines";

/**
 * Copies past Stripe invoices into the portal so reports have history. Read-only against Stripe and idempotent.
 * Only invoices of customers who are already portal clients are kept (run the client sync first).
 * It never sets a "first failed" date, so old unpaid invoices don't start payment-reminder or suspension clocks.
 */
export async function backfillInvoices(stripe: Stripe, since: Date): Promise<{ seen: number; stored: number; skipped: number }> {
  const known = new Set((await db.client.findMany({ where: { stripeCustomerId: { not: null } }, select: { stripeCustomerId: true } })).map((c) => c.stripeCustomerId!));
  let seen = 0;
  let stored = 0;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({ limit: 100, created: { gte: Math.floor(since.getTime() / 1000) }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const inv of page.data) {
      seen++;
      if (!known.has(idOf(inv.customer as string) ?? "")) continue;
      const paid = inv.status === "paid" ? await getPaidMethod(inv, stripe) : null;
      if (await upsertInvoiceFromStripe(inv, { paid })) stored++;
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return { seen, stored, skipped: seen - stored };
}
