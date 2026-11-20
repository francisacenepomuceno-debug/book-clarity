import type Stripe from "stripe";
import { db } from "@/lib/db";
import { idOf } from "@/stripe/lines";

/** Keeps Client.defaultPaymentFunding in step with the customer's default payment method. */
export async function onCustomerUpdated(
  cus: Stripe.Customer,
  getPaymentMethodFunding: (pmId: string) => Promise<string | null>,
): Promise<void> {
  const client = await db.client.findUnique({ where: { stripeCustomerId: cus.id } });
  if (!client) return;
  const pmId = idOf(cus.invoice_settings?.default_payment_method as string | null);
  const funding = pmId ? await getPaymentMethodFunding(pmId) : null;
  const billingState = cus.address?.state ?? client.billingState;
  if (funding !== client.defaultPaymentFunding || billingState !== client.billingState) {
    await db.client.update({ where: { id: client.id }, data: { defaultPaymentFunding: funding, billingState } });
  }
}
