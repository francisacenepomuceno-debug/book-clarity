import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { signLink, verifyLink } from "@/lib/links";

const PURPOSE = "update-payment";

/** Non-expiring link in reminders: opens a fresh Stripe page to update the card or switch to a bank account. */
export function updatePaymentLink(clientId: string, baseUrl: string): string {
  return `${baseUrl}/pay/update/${signLink(PURPOSE, clientId)}`;
}

export async function startPaymentUpdate(token: string, baseUrl: string): Promise<{ url: string } | { error: string }> {
  const clientId = verifyLink(PURPOSE, token);
  const client = clientId ? await db.client.findUnique({ where: { id: clientId } }) : null;
  if (!client || client.endedAt || !client.stripeCustomerId) {
    return { error: "This link is no longer active. Please contact Book Clarity if you need help with a payment." };
  }
  const session = await getStripe().billingPortal.sessions.create({
    customer: client.stripeCustomerId,
    return_url: `${baseUrl}/setup-complete?updated=1`,
    flow_data: { type: "payment_method_update" },
  });
  return { url: session.url };
}
