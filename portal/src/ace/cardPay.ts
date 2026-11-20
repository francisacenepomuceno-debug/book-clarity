import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { CARD_FEE_DESCRIPTION, decideCardFee } from "@/domain/cardFee";
import { getFeeSettings } from "@/settings/cardFee";
import { CARD_FEE_METADATA_KEY } from "@/stripe/lines";
import { signLink, verifyLink } from "@/lib/links";
import { writeAudit } from "@/audit/log";
import { getAceCustomerId } from "@/ace/batches";
import type { ActionResult } from "@/billing/discounts";

const PURPOSE = "ace-card-pay";

/** Owner: a link to send ACE when they want to pay a batch by card. */
export async function aceCardPayLink(batchId: string, baseUrl: string): Promise<ActionResult<{ url: string }>> {
  try {
    await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  const batch = await db.aceBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, error: "Batch not found." };
  if (batch.paidAt) return { ok: false, error: "This batch is already paid." };
  if (!(await getAceCustomerId())) return { ok: false, error: "Set ACE's Stripe customer in Settings first." };
  return { ok: true, url: `${baseUrl}/pay/ace/${signLink(PURPOSE, batchId)}` };
}

/** Public: ACE opened the card link. Opens a fresh Stripe page to enter the card (nothing is charged yet). */
export async function startAceCardCheckout(token: string, baseUrl: string): Promise<{ url: string } | { error: string }> {
  const batchId = verifyLink(PURPOSE, token);
  if (!batchId) return { error: "This link isn't valid. Please use the link Book Clarity sent you." };
  const batch = await db.aceBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { error: "This link isn't valid. Please use the link Book Clarity sent you." };
  if (batch.paidAt) return { error: "This batch is already paid. Thank you!" };
  const customer = await getAceCustomerId();
  if (!customer) return { error: "Card payment isn't available right now. Please contact Book Clarity." };
  const session = await getStripe().checkout.sessions.create({
    mode: "setup",
    customer,
    currency: "usd",
    allowed_payment_method_types: ["card"],
    metadata: { kind: "ACE_BATCH_CARD", batchId },
    success_url: `${baseUrl}/setup-complete?ace=1`,
    cancel_url: `${baseUrl}/setup-complete?ace=1&cancelled=1`,
  });
  return { url: session.url! };
}

/**
 * Webhook (checkout.session.completed, ACE_BATCH_CARD): reissue the batch invoice for card payment, with the 3% fee
 * line only for a credit card (per the card-fee settings), void the ACH invoice and charge the card.
 */
export async function onAceCardSetupCompleted(session: Stripe.Checkout.Session, stripe: Stripe = getStripe()): Promise<void> {
  const batchId = session.metadata?.batchId;
  if (!batchId) return;
  const batch = await db.aceBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.paidAt) return;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const siId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!customer || !siId) return;

  const si = await stripe.setupIntents.retrieve(siId, { expand: ["payment_method"] });
  const pm = si.payment_method as Stripe.PaymentMethod | null;
  if (!pm || typeof pm === "string") return;

  // Retire the previous invoice so ACE can't pay twice.
  if (batch.stripeInvoiceId) {
    const prev = await stripe.invoices.retrieve(batch.stripeInvoiceId);
    if (prev.status === "paid") return; // the invoice.paid webhook records it
    if (prev.status === "open") await stripe.invoices.voidInvoice(prev.id!);
  }

  const lines = await db.aceBatchLine.findMany({ where: { batchId }, orderBy: { id: "asc" } });
  const names = new Map((await db.package.findMany()).map((p) => [p.id, p.name]));
  const cus = (await stripe.customers.retrieve(customer)) as Stripe.Customer;
  const fee = decideCardFee({
    baseCents: batch.totalCents,
    paymentMethodType: pm.type,
    cardFunding: pm.type === "card" ? ((pm.card?.funding ?? "unknown") as "credit") : null,
    billingState: cus.address?.state ?? null,
    settings: await getFeeSettings(),
  });

  const key = `bc-ace-card-${session.id}`;
  const inv = await stripe.invoices.create(
    {
      customer,
      collection_method: "charge_automatically",
      auto_advance: false,
      default_payment_method: pm.id,
      metadata: { kind: "ACE_BATCH", batchId, payBy: "card" },
    },
    { idempotencyKey: `${key}-inv` },
  );
  for (const [n, l] of lines.entries()) {
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: inv.id!,
        amount: l.quantity * l.unitPriceCents,
        currency: "usd",
        description: `${l.quantity} × ${names.get(l.packageId)} — 6 months + onboarding (ACE)`,
        metadata: { kind: "ACE_BATCH", batchId },
      },
      { idempotencyKey: `${key}-line-${n}` },
    );
  }
  if (fee.feeCents > 0) {
    await stripe.invoiceItems.create(
      {
        customer,
        invoice: inv.id!,
        amount: fee.feeCents,
        currency: "usd",
        description: CARD_FEE_DESCRIPTION,
        discountable: false,
        metadata: { [CARD_FEE_METADATA_KEY]: "1", kind: "ACE_BATCH", batchId },
      },
      { idempotencyKey: `${key}-fee` },
    );
  }
  await stripe.invoices.finalizeInvoice(inv.id!);
  await db.aceBatch.update({ where: { id: batchId }, data: { stripeInvoiceId: inv.id!, invoiceSentAt: new Date() } });
  await writeAudit({ actorId: null, action: "ace_batch_card_invoice", entity: "AceBatch", entityId: batchId, after: { invoiceId: inv.id, feeCents: fee.feeCents, funding: pm.card?.funding } });

  try {
    await stripe.invoices.pay(inv.id!, { payment_method: pm.id }, { idempotencyKey: `bc-ace-card-pay-${session.id}` });
  } catch (e) {
    // Declined: the invoice stays open; ACE can use the card link again (it reissues the invoice).
    await writeAudit({ actorId: null, action: "ace_batch_card_declined", entity: "AceBatch", entityId: batchId, after: { message: (e as Error).message } });
  }
}
