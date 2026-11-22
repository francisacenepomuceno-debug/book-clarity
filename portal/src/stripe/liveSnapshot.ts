import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/stripe/client";
import { mapSubscription, type LiveClientRow } from "@/stripe/mapSubscription";
import { syncClientsFromSnapshot } from "@/clients/queries";

export type LiveSnapshot = { rows: LiveClientRow[]; fetchedAt: Date; livemode: boolean };

const CACHE_MS = 60_000;
let cache: LiveSnapshot | null = null;

/** Read-only pull of every non-cancelled subscription. Never writes to Stripe. */
export async function getLiveSnapshot(force = false): Promise<LiveSnapshot> {
  if (!force && cache && Date.now() - cache.fetchedAt.getTime() < CACHE_MS) return cache;
  const stripe = getStripe();

  const productNames = new Map<string, string>();
  for await (const p of stripe.products.list({ limit: 100 })) productNames.set(p.id, p.name);

  const subs: Stripe.Subscription[] = [];
  for await (const s of stripe.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.customer.invoice_settings.default_payment_method", "data.default_payment_method", "data.latest_invoice"],
  })) {
    if (s.status !== "canceled" && s.status !== "incomplete_expired") subs.push(s);
  }

  const now = new Date();
  cache = {
    rows: subs.map((s) => mapSubscription(s, productNames, now)),
    fetchedAt: now,
    livemode: subs[0]?.livemode ?? false,
  };
  await syncClientsFromSnapshot(cache.rows);
  return cache;
}

/** Forget the cached snapshot (after the portal changes a subscription), so the next page load shows it. */
export function clearLiveSnapshot(): void {
  cache = null;
}
