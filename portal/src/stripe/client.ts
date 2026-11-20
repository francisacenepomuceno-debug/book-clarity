import Stripe from "stripe";

let client: Stripe | null = null;

/** Server-only Stripe client. Uses the fetch HTTP client so HTTPS_PROXY is honoured. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  client ??= new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
  return client;
}
