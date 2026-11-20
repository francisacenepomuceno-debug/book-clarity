import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { upsertInvoiceFromStripe, type PaidMethod } from "@/stripe/handlers/invoice";
import { onSubscriptionChanged } from "@/stripe/handlers/subscription";
import { onCustomerUpdated } from "@/stripe/handlers/customer";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { onChargeRefunded, type RefundInfo } from "@/stripe/handlers/refund";

export type WebhookDeps = {
  /** How a paid invoice was paid: method type, card funding, and the charge (for fee refunds). */
  getPaidMethod: (inv: Stripe.Invoice) => Promise<PaidMethod | null>;
  /** "credit" | "debit" | "prepaid" | "unknown" for cards, the method type otherwise. */
  getPaymentMethodFunding: (pmId: string) => Promise<string | null>;
  /** Extension points used by the card-fee logic (Task 5). */
  onInvoiceCreated: (inv: Stripe.Invoice) => Promise<void>;
  onInvoicePaid: (inv: Stripe.Invoice, paid: PaidMethod | null) => Promise<void>;
  /** Which Stripe invoice a refunded charge paid (null if none). */
  getInvoiceIdForCharge?: (charge: Stripe.Charge) => Promise<string | null>;
  /** Called once per newly seen refund; the commission engine claws back from it. */
  onRefund?: (invoiceRowId: string, refund: RefundInfo) => Promise<void>;
  /** ACE paid a batch invoice (metadata.kind = ACE_BATCH). */
  onAceBatchPaid?: (inv: Stripe.Invoice) => Promise<void>;
  /** An ACE client finished the setup link (checkout.session.completed, ACE_CONTINUATION). */
  onAceSetupCompleted?: (session: Stripe.Checkout.Session) => Promise<void>;
  /** ACE saved a card to pay a batch (checkout.session.completed, ACE_BATCH_CARD). */
  onAceCardSetupCompleted?: (session: Stripe.Checkout.Session) => Promise<void>;
  /** Client notices: payment coming up (invoice.upcoming) and payment failed (day 0). */
  onUpcomingInvoice?: (inv: Stripe.Invoice) => Promise<void>;
  onPaymentFailedNotice?: (invoiceRowId: string) => Promise<void>;
  /** New-client onboarding (Plan 4B): method saved, fee paid, fee failed. */
  onOnboardingSetupSucceeded?: (si: Stripe.SetupIntent) => Promise<void>;
  onOnboardingFeePaid?: (inv: Stripe.Invoice) => Promise<void>;
  onOnboardingFeeFailed?: (inv: Stripe.Invoice) => Promise<void>;
  /** Which Stripe invoice a payment intent pays (for ACH "processing"). */
  getInvoiceIdForPaymentIntent?: (paymentIntentId: string) => Promise<string | null>;
};

/** An unfinished attempt older than this is assumed dead and may be retried. */
export const STALE_CLAIM_MS = 5 * 60_000;

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
  "charge.refunded",
  "checkout.session.completed",
  "invoice.upcoming",
  "payment_intent.processing",
  "setup_intent.succeeded",
]);

/** Verified events only. Idempotent by event.id; a failed handler un-records the event so Stripe's retry runs. */
export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<HandleResult> {
  try {
    await db.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    // Seen before. Re-claim it only if an earlier attempt started long ago and never finished (crash/timeout).
    const claimed = await db.stripeEvent.updateMany({
      where: { id: event.id, processedAt: null, receivedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      data: { receivedAt: new Date() },
    });
    if (claimed.count === 0) return "duplicate";
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
      if (row) await deps.onPaymentFailedNotice?.(row.id);
      if ((obj as Stripe.Invoice).metadata?.kind === "ONBOARDING") await deps.onOnboardingFeeFailed?.(obj as Stripe.Invoice);
      return;
    }
    case "payment_intent.processing": {
      // A bank (ACH) payment is under way: hold reminders until it succeeds or fails.
      const pi = obj as Stripe.PaymentIntent;
      const stripeInvoiceId = await deps.getInvoiceIdForPaymentIntent?.(pi.id);
      if (stripeInvoiceId) await db.invoice.updateMany({ where: { stripeInvoiceId }, data: { processingSince: new Date() } });
      return;
    }
    case "invoice.upcoming": {
      await deps.onUpcomingInvoice?.(obj as Stripe.Invoice);
      return;
    }
    case "invoice.paid": {
      const inv = obj as Stripe.Invoice;
      if (inv.metadata?.kind === "ACE_BATCH") return deps.onAceBatchPaid?.(inv);
      const paid = await deps.getPaidMethod(inv);
      const row = await upsertInvoiceFromStripe(inv, { paid });
      if (row?.clientId) await refreshClientStatus(row.clientId);
      if (row) await deps.onInvoicePaid(inv, paid);
      if (inv.metadata?.kind === "ONBOARDING") await deps.onOnboardingFeePaid?.(inv);
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
    case "checkout.session.completed": {
      const session = obj as Stripe.Checkout.Session;
      if (session.metadata?.kind === "ACE_CONTINUATION") await deps.onAceSetupCompleted?.(session);
      if (session.metadata?.kind === "ACE_BATCH_CARD") await deps.onAceCardSetupCompleted?.(session);
      return;
    }
    case "setup_intent.succeeded": {
      const si = obj as Stripe.SetupIntent;
      if (si.metadata?.kind === "ONBOARDING_SETUP") await deps.onOnboardingSetupSucceeded?.(si);
      return;
    }
    case "charge.refunded":
      return onChargeRefunded(obj as Stripe.Charge, deps);
    case "customer.updated":
      return onCustomerUpdated(obj as Stripe.Customer, deps.getPaymentMethodFunding);
  }
}
