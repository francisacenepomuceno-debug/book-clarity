import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { upsertInvoiceFromStripe, type PaidMethod } from "@/stripe/handlers/invoice";
import { onSubscriptionChanged } from "@/stripe/handlers/subscription";
import { onCustomerUpdated } from "@/stripe/handlers/customer";
import { refreshClientStatus } from "@/stripe/clientStatusSync";

export type WebhookDeps = {
  /** How a paid invoice was paid: method type, card funding, and the charge (for fee refunds). */
  getPaidMethod: (inv: Stripe.Invoice) => Promise<PaidMethod | null>;
  /** "credit" | "debit" | "prepaid" | "unknown" for cards, the method type otherwise. */
  getPaymentMethodFunding: (pmId: string) => Promise<string | null>;
  /** Extension points used by the card-fee logic (Task 5). */
  onInvoiceCreated: (inv: Stripe.Invoice) => Promise<void>;
  onInvoicePaid: (inv: Stripe.Invoice, paid: PaidMethod | null) => Promise<void>;
};

export type HandleResult = "processed" | "duplicate" | "ignored";

const HANDLED = new Set([
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.updated",
]);

/** Verified events only. Idempotent by event.id; a failed handler un-records the event so Stripe's retry runs. */
export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<HandleResult> {
  try {
    await db.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }

  if (!HANDLED.has(event.type)) {
    await db.stripeEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    return "ignored";
  }

  try {
    await dispatch(event, deps);
    await db.stripeEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    return "processed";
  } catch (e) {
    await db.stripeEvent.deleteMany({ where: { id: event.id } });
    throw e;
  }
}

async function dispatch(event: Stripe.Event, deps: WebhookDeps): Promise<void> {
  const obj = event.data.object as unknown;
  switch (event.type) {
    case "invoice.payment_failed": {
      const row = await upsertInvoiceFromStripe(obj as Stripe.Invoice, { failedNow: true });
      if (row?.clientId) await refreshClientStatus(row.clientId);
      return;
    }
    case "invoice.paid": {
      const inv = obj as Stripe.Invoice;
      const paid = await deps.getPaidMethod(inv);
      const row = await upsertInvoiceFromStripe(inv, { paid });
      if (row?.clientId) await refreshClientStatus(row.clientId);
      if (row) await deps.onInvoicePaid(inv, paid);
      return;
    }
    case "invoice.created": {
      const inv = obj as Stripe.Invoice;
      const row = await upsertInvoiceFromStripe(inv);
      if (row) await deps.onInvoiceCreated(inv);
      return;
    }
    case "invoice.finalized":
    case "invoice.updated":
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      const row = await upsertInvoiceFromStripe(obj as Stripe.Invoice);
      if (row?.clientId) await refreshClientStatus(row.clientId);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return onSubscriptionChanged(obj as Stripe.Subscription, false);
    case "customer.subscription.deleted":
      return onSubscriptionChanged(obj as Stripe.Subscription, true);
    case "customer.updated":
      return onCustomerUpdated(obj as Stripe.Customer, deps.getPaymentMethodFunding);
  }
}
