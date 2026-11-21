import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { CARD_FEE_DESCRIPTION, decideCardFee } from "@/domain/cardFee";
import { getFeeSettings } from "@/settings/cardFee";
import { CARD_FEE_METADATA_KEY, idOf } from "@/stripe/lines";
import { writeAudit } from "@/audit/log";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { loadOnboarding, type Details } from "@/onboarding/steps";
import { onboardingLink } from "@/onboarding/start";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { formatUsd } from "@/lib/money";

/** First monthly charge: this many days after the onboarding fee is paid (owner, 2026-11-20). */
export const FIRST_CHARGE_DAYS = 14;
const DAY_MS = 86400_000;

export type PayOptions = {
  onboardingId: string;
  feeCents: number;
  creditCardFeeCents: number;
  declined: boolean;
  /** Monthly amount, and its 3% with a credit card: charged right away when the fee is waived. */
  monthlyCents: number;
  creditCardMonthlyFeeCents: number;
};

/** Public: the payment step: the fee, the extra for a credit card, and whether the last attempt was declined. */
export async function onboardingPayOptions(token: string): Promise<PayOptions | { error: string }> {
  const l = await loadOnboarding(token);
  if ("error" in l) return l;
  if (l.step !== "payment") return { error: "This step isn't available right now. Please reload the page." };
  const feeCents = l.onboarding.onboardingFeeCents ?? l.pkg?.onboardingFeeCents ?? 0;
  const fee = decideCardFee({ baseCents: feeCents, paymentMethodType: "card", cardFunding: "credit", billingState: (l.onboarding.details as Partial<Details> | null)?.state ?? null, settings: await getFeeSettings() });
  const monthlyCents = l.onboarding.monthlyCents ?? l.pkg?.monthlyPriceCents ?? 0;
  const monthlyFee = decideCardFee({ baseCents: monthlyCents, paymentMethodType: "card", cardFunding: "credit", billingState: (l.onboarding.details as Partial<Details> | null)?.state ?? null, settings: await getFeeSettings() });
  return { onboardingId: l.onboarding.id, feeCents, creditCardFeeCents: fee.feeCents, declined: Boolean(l.onboarding.feeInvoiceId), monthlyCents, creditCardMonthlyFeeCents: monthlyFee.feeCents };
}

/** Public: opens Stripe to save a bank account or card (nothing is charged on that page). */
export async function startOnboardingPayment(token: string, method: "bank" | "card", baseUrl: string, stripe: Stripe = getStripe()): Promise<{ url: string } | { error: string }> {
  const opts = await onboardingPayOptions(token);
  if ("error" in opts) return opts;
  const o = await db.onboarding.findUniqueOrThrow({ where: { id: opts.onboardingId }, include: { client: true } });
  let customer = o.client.stripeCustomerId;
  if (!customer) {
    const d = (o.details ?? {}) as Partial<Details>;
    const c = await stripe.customers.create(
      {
        name: o.client.name,
        email: o.client.email ?? undefined,
        phone: d.phone || undefined,
        address: { line1: d.address1 || undefined, line2: d.address2 || undefined, city: d.city || undefined, state: d.state || undefined, postal_code: d.zip || undefined, country: "US" },
        metadata: { portalClientId: o.clientId },
      },
      { idempotencyKey: `bc-onb-cus-${o.id}` },
    );
    customer = c.id;
    await db.client.updateMany({ where: { id: o.clientId, stripeCustomerId: null }, data: { stripeCustomerId: customer } });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer,
    currency: "usd",
    allowed_payment_method_types: [method === "bank" ? "us_bank_account" : "card"],
    setup_intent_data: { metadata: { kind: "ONBOARDING_SETUP", onboardingId: o.id } },
    metadata: { kind: "ONBOARDING_SETUP", onboardingId: o.id },
    success_url: `${baseUrl}/setup-complete?onboarding=${token}`,
    cancel_url: `${baseUrl}/setup-complete?onboarding=${token}&cancelled=1`,
  });
  return { url: session.url! };
}

/**
 * Webhook (setup_intent.succeeded, ONBOARDING_SETUP): the client saved a bank account or card.
 * Charges the onboarding fee (plus 3% for a credit card), or with no fee starts billing straight away.
 * Fires once the method is usable, so a bank account that needs micro-deposit checks is charged after that.
 */
export async function onOnboardingSetupSucceeded(si: Stripe.SetupIntent, stripe: Stripe = getStripe()): Promise<void> {
  const onboardingId = si.metadata?.onboardingId;
  if (!onboardingId) return;
  const o = await db.onboarding.findUnique({ where: { id: onboardingId }, include: { client: true } });
  if (!o || o.feePaidAt || o.feeSubmittedAt || o.client.stripeSubscriptionId) return;
  if (o.feeSetupSessionId === si.id) return; // this setup was already handled (duplicate event)

  const full = await stripe.setupIntents.retrieve(si.id, { expand: ["payment_method"] });
  const pm = full.payment_method as Stripe.PaymentMethod | null;
  if (!pm || typeof pm === "string") return;
  const customer = o.client.stripeCustomerId ?? idOf(full.customer as string) ?? idOf(si.customer as string);
  if (!customer) return;
  if (!o.client.stripeCustomerId) await db.client.update({ where: { id: o.clientId }, data: { stripeCustomerId: customer } });
  // Autopay: monthly charges use this method.
  await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm.id } });

  const feeCents = o.onboardingFeeCents ?? 0;
  if (feeCents === 0) {
    const now = new Date();
    await db.onboarding.update({ where: { id: o.id }, data: { feeSetupSessionId: si.id, feePaymentMethodId: pm.id, feePaidAt: now, feeSubmittedAt: now, lastProgressAt: now } });
    await recompleteIfDone(o.id, now);
    // Waived fee: the first month is billed now, then monthly on this date (owner, 2026-11-21).
    await ensureSubscription(o.id, stripe, pm);
    return;
  }

  // A new method after a decline: retire the old unpaid invoice so the fee can't be paid twice.
  if (o.feeInvoiceId) {
    const prev = await stripe.invoices.retrieve(o.feeInvoiceId);
    if (prev.status === "paid") return; // invoice.paid records it
    if (prev.status === "open" || prev.status === "draft") await stripe.invoices.voidInvoice(prev.id!);
  }

  const cus = (await stripe.customers.retrieve(customer)) as Stripe.Customer;
  const fee = decideCardFee({
    baseCents: feeCents,
    paymentMethodType: pm.type,
    cardFunding: pm.type === "card" ? ((pm.card?.funding ?? "unknown") as "credit") : null,
    billingState: cus.address?.state ?? null,
    settings: await getFeeSettings(),
  });
  const pkg = o.packageId ? await db.package.findUnique({ where: { id: o.packageId } }) : null;
  const key = `bc-onb-fee-${si.id}`;
  const inv = await stripe.invoices.create(
    {
      customer,
      collection_method: "charge_automatically",
      auto_advance: false,
      default_payment_method: pm.id,
      payment_settings: { payment_method_types: [pm.type as Stripe.InvoiceCreateParams.PaymentSettings.PaymentMethodType] },
      metadata: { kind: "ONBOARDING", onboardingId: o.id },
    },
    { idempotencyKey: `${key}-inv` },
  );
  await stripe.invoiceItems.create(
    { customer, invoice: inv.id!, amount: feeCents, currency: "usd", description: `${pkg?.name ?? "Bookkeeping"} onboarding fee`, metadata: { kind: "ONBOARDING", onboardingId: o.id } },
    { idempotencyKey: `${key}-line` },
  );
  if (fee.feeCents > 0) {
    await stripe.invoiceItems.create(
      { customer, invoice: inv.id!, amount: fee.feeCents, currency: "usd", description: CARD_FEE_DESCRIPTION, discountable: false, metadata: { [CARD_FEE_METADATA_KEY]: "1", onboardingId: o.id } },
      { idempotencyKey: `${key}-fee` },
    );
  }
  await stripe.invoices.finalizeInvoice(inv.id!);
  await db.onboarding.update({ where: { id: o.id }, data: { feeInvoiceId: inv.id!, feeSetupSessionId: si.id, feePaymentMethodId: pm.id } });
  await writeAudit({ actorId: null, action: "onboarding_fee_invoice", entity: "Onboarding", entityId: o.id, after: { invoiceId: inv.id, feeCents, cardFeeCents: fee.feeCents, method: pm.type, funding: pm.card?.funding ?? null } });

  try {
    const paid = await stripe.invoices.pay(inv.id!, { payment_method: pm.id }, { idempotencyKey: `${key}-pay` });
    // "paid" (card) or still "open" while a bank payment clears: either way the client can carry on.
    if (paid.status === "paid" || paid.status === "open") {
      const now = new Date();
      await db.onboarding.update({ where: { id: o.id }, data: { feeSubmittedAt: now, lastProgressAt: now } });
      await recompleteIfDone(o.id, now);
    }
  } catch (e) {
    // Declined: the payment page offers to try again (a new setup voids this invoice).
    await writeAudit({ actorId: null, action: "onboarding_fee_declined", entity: "Onboarding", entityId: o.id, after: { message: (e as Error).message } });
  }
}

/** A client who already did every other step (their earlier payment bounced) is complete again once they've paid. */
async function recompleteIfDone(onboardingId: string, now: Date) {
  await db.onboarding.updateMany({ where: { id: onboardingId, completedAt: null, callBookedAt: { not: null }, intakeAt: { not: null } }, data: { completedAt: now } });
}

/** Webhook (invoice.paid, kind ONBOARDING): records the fee and starts monthly billing 14 days after it was paid. */
export async function onOnboardingFeePaid(inv: Stripe.Invoice, stripe: Stripe = getStripe()): Promise<void> {
  const onboardingId = inv.metadata?.onboardingId;
  if (!onboardingId) return;
  const paidAt = inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : new Date();
  await db.onboarding.updateMany({ where: { id: onboardingId, feePaidAt: null }, data: { feePaidAt: paidAt } });
  await db.onboarding.updateMany({ where: { id: onboardingId, feeSubmittedAt: null }, data: { feeSubmittedAt: paidAt } });
  await ensureSubscription(onboardingId, stripe);
}

/** Creates the client's monthly subscription once (safe to call again: Stripe idempotency + the stored id). */
async function ensureSubscription(onboardingId: string, stripe: Stripe, savedMethod?: Stripe.PaymentMethod): Promise<void> {
  const o = await db.onboarding.findUnique({ where: { id: onboardingId }, include: { client: true } });
  if (!o?.feePaidAt || o.client.stripeSubscriptionId || !o.client.stripeCustomerId) return;
  const pkg = o.packageId ? await db.package.findUnique({ where: { id: o.packageId } }) : null;
  if (!pkg?.stripePriceId) throw new Error(`Package for onboarding ${o.id} has no Stripe price; set it on the Packages page`);

  let item: Stripe.SubscriptionCreateParams.Item = { price: pkg.stripePriceId };
  if (pkg.isCustom || (o.monthlyCents != null && o.monthlyCents !== pkg.monthlyPriceCents)) {
    const price = await stripe.prices.retrieve(pkg.stripePriceId);
    item = { price_data: { currency: "usd", product: idOf(price.product as string)!, unit_amount: o.monthlyCents!, recurring: { interval: "month" } } };
  }
  // With a waived onboarding fee the first month is charged straight away; otherwise 14 days after the fee.
  const waived = (o.onboardingFeeCents ?? 0) === 0;
  const firstCharge = waived ? new Date() : new Date(o.feePaidAt.getTime() + FIRST_CHARGE_DAYS * DAY_MS);
  if (waived && savedMethod) {
    // The first invoice is finalized at once, before the usual card-fee step can add the 3%, so add it here
    // as a pending item that the subscription's first invoice picks up (credit cards only, per the fee settings).
    const cus = (await stripe.customers.retrieve(o.client.stripeCustomerId)) as Stripe.Customer;
    const fee = decideCardFee({
      baseCents: o.monthlyCents ?? pkg.monthlyPriceCents,
      paymentMethodType: savedMethod.type,
      cardFunding: savedMethod.type === "card" ? ((savedMethod.card?.funding ?? "unknown") as "credit") : null,
      billingState: cus.address?.state ?? null,
      settings: await getFeeSettings(),
    });
    if (fee.feeCents > 0) {
      await stripe.invoiceItems.create(
        { customer: o.client.stripeCustomerId, amount: fee.feeCents, currency: "usd", description: CARD_FEE_DESCRIPTION, discountable: false, metadata: { [CARD_FEE_METADATA_KEY]: "1", onboardingId: o.id } },
        { idempotencyKey: `bc-onb-firstfee-${o.id}` },
      );
    }
  }
  const sub = await stripe.subscriptions.create(
    {
      customer: o.client.stripeCustomerId,
      items: [item],
      ...(waived ? {} : { trial_end: Math.floor(firstCharge.getTime() / 1000) }),
      ...(o.feePaymentMethodId ? { default_payment_method: o.feePaymentMethodId } : {}),
      proration_behavior: "none",
      metadata: { onboardingId: o.id, portalClientId: o.clientId },
    },
    { idempotencyKey: `bc-onb-sub-${o.id}` },
  );
  await db.client.update({ where: { id: o.clientId }, data: { stripeSubscriptionId: sub.id, subscriptionStatus: sub.status } });
  await db.onboarding.update({ where: { id: o.id }, data: { stripeSubscriptionId: sub.id } });
  await writeAudit({ actorId: null, action: "onboarding_subscription_started", entity: "Client", entityId: o.clientId, after: { subscriptionId: sub.id, firstCharge, feeWaived: waived } });
  await refreshClientStatus(o.clientId);
}

/** Webhook (invoice.payment_failed, kind ONBOARDING): e.g. a bank payment bounced. Back to the payment step. */
export async function onOnboardingFeeFailed(inv: Stripe.Invoice): Promise<void> {
  const onboardingId = inv.metadata?.onboardingId;
  if (!onboardingId) return;
  const o = await db.onboarding.findUnique({ where: { id: onboardingId }, include: { client: true } });
  if (!o || o.feePaidAt || o.feeInvoiceId !== inv.id) return;
  // Even if they already finished every other step, the link reopens on the payment step.
  await db.onboarding.update({ where: { id: o.id }, data: { feeSubmittedAt: null, completedAt: null } });
  const amount = formatUsd(o.onboardingFeeCents ?? 0);
  const t = templates.onboardingFeeFailed({ name: o.client.name, amount, url: onboardingLink(o.id) });
  await sendNotice({ key: `onboarding-fee-failed:${inv.id}`, kind: "onboarding-fee-failed", clientId: o.clientId, to: { name: o.client.name, email: o.client.email, phone: o.client.phone }, email: t, sms: t.sms });
  const owners = await db.user.findMany({ where: { role: "OWNER" } });
  for (const u of owners) {
    await sendNotice({
      key: `onboarding-fee-failed-staff:${inv.id}:${u.id}`,
      kind: "onboarding-fee-failed-staff",
      to: { name: u.name, email: u.email },
      email: { subject: `${o.client.name}'s onboarding fee didn't go through`, html: `<p>${o.client.name}'s onboarding fee of ${amount} failed (a bank payment can bounce days later). They've been asked to pay again from their onboarding link; monthly billing won't start until they do.</p>` },
    });
  }
}
