import type Stripe from "stripe";
import { getStripe } from "@/stripe/client";
import type { WebhookDeps } from "@/stripe/webhook";
import type { PaidMethod } from "@/stripe/handlers/invoice";
import { applyCardFeeToDraft, reconcileCardFee } from "@/stripe/handlers/cardFee";
import { recordPaymentCommission, recordRefundClawback } from "@/commissions/engine";
import { db } from "@/lib/db";

function methodFromCharge(ch: Stripe.Charge | null | undefined): PaidMethod | null {
  const d = ch?.payment_method_details;
  if (!ch || !d) return null;
  return { type: d.type, funding: d.type === "card" ? d.card?.funding ?? "unknown" : null, chargeId: ch.id };
}

/** Finds the successful charge behind a paid invoice (invoice payments → payment intent → latest charge). */
export async function getPaidMethod(inv: Stripe.Invoice, stripe: Stripe = getStripe()): Promise<PaidMethod | null> {
  const payments = await stripe.invoicePayments.list({
    invoice: inv.id!,
    status: "paid",
    expand: ["data.payment.payment_intent.latest_charge", "data.payment.charge"],
  });
  for (const p of payments.data) {
    const pi = p.payment.payment_intent;
    const charge = typeof pi === "object" && pi ? (pi.latest_charge as Stripe.Charge | null) : (p.payment.charge as Stripe.Charge | null);
    const m = methodFromCharge(typeof charge === "object" ? charge : null);
    if (m) return m;
  }
  return null; // paid out of band, or by credit balance
}

export async function getPaymentMethodFunding(pmId: string, stripe: Stripe = getStripe()): Promise<string | null> {
  const pm = await stripe.paymentMethods.retrieve(pmId);
  return pm.type === "card" ? pm.card?.funding ?? "unknown" : pm.type;
}

/** The invoice a charge paid, via the invoice payment that references its payment intent. */
export async function getInvoiceIdForCharge(charge: Stripe.Charge, stripe: Stripe = getStripe()): Promise<string | null> {
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return null;
  const res = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
  const inv = res.data[0]?.invoice;
  return typeof inv === "string" ? inv : inv?.id ?? null;
}

export function defaultWebhookDeps(over: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    getPaidMethod: (inv) => getPaidMethod(inv),
    getPaymentMethodFunding: (id) => getPaymentMethodFunding(id),
    onInvoiceCreated: async (inv) => {
      await applyCardFeeToDraft(inv, getStripe());
    },
    onInvoicePaid: async (inv, paid) => {
      // Commission first: it is idempotent and must not be skipped if the fee reconcile throws (Stripe retries).
      const row = await db.invoice.findUnique({ where: { stripeInvoiceId: inv.id! }, select: { id: true } });
      if (row) await recordPaymentCommission(row.id);
      await reconcileCardFee(inv, paid, getStripe());
    },
    getInvoiceIdForCharge: (charge) => getInvoiceIdForCharge(charge),
    onAceBatchPaid: async (inv) => {
      const { onBatchInvoicePaid } = await import("@/ace/batches");
      await onBatchInvoicePaid(inv);
    },
    onRefund: async (invoiceRowId, refund) => {
      await recordRefundClawback(invoiceRowId, { refundKey: refund.refundKey, packageCents: refund.packageCents });
    },
    ...over,
  };
}
