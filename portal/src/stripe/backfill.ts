import type Stripe from "stripe";
import { db } from "@/lib/db";
import { upsertInvoiceFromStripe } from "@/stripe/handlers/invoice";
import { getPaidMethod } from "@/stripe/deps";
import { idOf } from "@/stripe/lines";
import { getAceCustomerId } from "@/ace/batches";

const fromTs = (t: number | null | undefined) => (t ? new Date(t * 1000) : null);

/**
 * Copies past Stripe invoices into the portal so reports have history. Read-only against Stripe and idempotent.
 * - Invoices it creates are marked as history: they never earn commission or count toward a commission window
 *   (months before the portal are entered on each client instead), and never get a "first failed" date, so they
 *   can't start payment reminders or suspension.
 * - Customers whose subscriptions have all ended are added as ended clients, so past revenue includes them.
 *   ACE's customer and customers with no subscription (one-off invoices) are skipped.
 * - Each client's start date is taken from their Stripe subscription, so existing clients don't show up as
 *   "new" in the first month loaded.
 */
export async function backfillInvoices(stripe: Stripe, since: Date): Promise<{ seen: number; stored: number; skipped: number; clientsAdded: number }> {
  const ace = await getAceCustomerId();
  const clients = await db.client.findMany({ where: { stripeCustomerId: { not: null } } });
  const known = new Set(clients.map((c) => c.stripeCustomerId!));
  const rejected = new Set<string>(ace ? [ace] : []);
  let clientsAdded = 0;

  // Start dates for current clients.
  for (const c of clients) {
    if (c.startedAt || !c.stripeSubscriptionId) continue;
    const sub = await stripe.subscriptions.retrieve(c.stripeSubscriptionId);
    const start = fromTs(sub.start_date);
    if (start) await db.client.update({ where: { id: c.id }, data: { startedAt: start } });
  }

  async function ensureClient(customer: string): Promise<boolean> {
    if (known.has(customer)) return true;
    if (rejected.has(customer)) return false;
    const subs = (await stripe.subscriptions.list({ customer, status: "all", limit: 100 })).data;
    const allEnded = subs.length > 0 && subs.every((s) => s.status === "canceled" || s.status === "incomplete_expired");
    if (!allEnded) {
      rejected.add(customer); // ACE, one-off invoices, or a live subscription the client sync will pick up
      return false;
    }
    const latest = [...subs].sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0))[0];
    const cus = (await stripe.customers.retrieve(customer)) as Stripe.Customer;
    await db.client.upsert({
      where: { stripeCustomerId: customer },
      create: {
        name: cus.name || cus.email || customer,
        email: cus.email ?? null,
        stripeCustomerId: customer,
        status: "ENDED",
        endedAt: fromTs(latest.ended_at) ?? new Date(),
        startedAt: fromTs(Math.min(...subs.map((s) => s.start_date))),
        subscriptionStatus: latest.status,
      },
      update: {},
    });
    known.add(customer);
    clientsAdded++;
    return true;
  }

  let seen = 0;
  let stored = 0;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({ limit: 100, created: { gte: Math.floor(since.getTime() / 1000) }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const inv of page.data) {
      seen++;
      const customer = idOf(inv.customer as string);
      if (!customer || !(await ensureClient(customer))) continue;
      const paid = inv.status === "paid" ? await getPaidMethod(inv, stripe) : null;
      if (await upsertInvoiceFromStripe(inv, { paid, backfilled: true })) stored++;
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return { seen, stored, skipped: seen - stored, clientsAdded };
}
