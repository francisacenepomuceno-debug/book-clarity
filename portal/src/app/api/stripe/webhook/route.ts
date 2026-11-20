import type Stripe from "stripe";
import { getStripe } from "@/stripe/client";
import { handleStripeEvent } from "@/stripe/webhook";
import { defaultWebhookDeps } from "@/stripe/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get("stripe-signature");
  if (!secret || !signature) return Response.json({ error: "missing signature" }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(body, signature, secret);
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event, defaultWebhookDeps());
    return Response.json({ result });
  } catch (e) {
    console.error(`[stripe] ${event.type} ${event.id} failed:`, (e as Error).message);
    return Response.json({ error: "handler failed" }, { status: 500 }); // Stripe retries
  }
}
