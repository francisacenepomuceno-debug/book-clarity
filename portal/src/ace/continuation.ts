import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { CONTINUATION_NOTICE_DAYS } from "@/domain/ace";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that." };

async function aceManager() {
  try {
    return await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

/** ACE clients within 30 days of the end of their prepaid period (or past it) who have no subscription yet. */
export async function dueForContinuation(now: Date = new Date()) {
  const rows = await db.client.findMany({
    where: {
      type: "ACE",
      endedAt: null,
      stripeSubscriptionId: null,
      acePrepaidUntil: { not: null, lte: new Date(now.getTime() + CONTINUATION_NOTICE_DAYS * 86400_000) },
    },
    orderBy: { acePrepaidUntil: "asc" },
  });
  return rows.map((c) => ({ clientId: c.id, name: c.name, prepaidUntil: c.acePrepaidUntil!, decision: c.continuationDecision }));
}

/** The client wants to continue: record it and create a Stripe setup link for them to save a card or bank account. */
export async function markContinuing(clientId: string, baseUrl: string): Promise<ActionResult<{ setupUrl: string }>> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client || client.type !== "ACE" || !client.aceSlotId) return { ok: false, error: "This isn't an ACE client." };
  if (client.stripeSubscriptionId) return { ok: false, error: "This client already has autopay set up." };
  const pkg = client.packageId ? await db.package.findUnique({ where: { id: client.packageId } }) : null;
  if (!pkg) return { ok: false, error: "This client has no package." };
  if (!pkg.isCustom && !pkg.stripePriceId) return { ok: false, error: "Link this package to a Stripe price in Settings → Packages." };

  const stripe = getStripe();
  let customerId = client.stripeCustomerId;
  if (!customerId) {
    const cus = await stripe.customers.create(
      { name: client.name, email: client.email ?? undefined, metadata: { clientId } },
      { idempotencyKey: `bc-ace-cus-${clientId}` },
    );
    customerId = cus.id;
    await db.client.update({ where: { id: clientId }, data: { stripeCustomerId: customerId } });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    currency: "usd",
    allowed_payment_method_types: ["card", "us_bank_account"],
    metadata: { kind: "ACE_CONTINUATION", clientId },
    success_url: `${baseUrl}/setup-complete`,
    cancel_url: `${baseUrl}/setup-complete?cancelled=1`,
  });
  await db.client.update({ where: { id: clientId }, data: { continuationDecision: "CONTINUING" } });
  await refreshClientStatus(clientId);
  await writeAudit({ actorId: actor.id, action: "ace_continuing", entity: "Client", entityId: clientId, after: { sessionId: session.id } });
  return { ok: true, setupUrl: session.url! };
}

/** The client won't continue: service ends when the prepaid period ends (staff decision, never automatic). */
export async function markEnded(clientId: string): Promise<ActionResult> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client || client.type !== "ACE") return { ok: false, error: "This isn't an ACE client." };
  if (client.stripeSubscriptionId) return { ok: false, error: "This client is on autopay; cancel their subscription instead." };
  const now = new Date();
  const endedAt = client.acePrepaidUntil && client.acePrepaidUntil > now ? client.acePrepaidUntil : now;
  await db.client.update({ where: { id: clientId }, data: { continuationDecision: "ENDING", endedAt } });
  await refreshClientStatus(clientId);
  await writeAudit({ actorId: actor.id, action: "ace_ending", entity: "Client", entityId: clientId, after: { endedAt } });
  return { ok: true };
}

/**
 * Webhook (checkout.session.completed, ACE_CONTINUATION): make the saved method the default and start the
 * subscription, first charge the day after the prepaid period. Idempotent.
 */
export async function onSetupCompleted(session: Stripe.Checkout.Session, stripe: Stripe = getStripe()): Promise<void> {
  const clientId = session.metadata?.clientId;
  if (!clientId) return;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client || client.stripeSubscriptionId || !client.acePrepaidUntil || !client.packageId) return;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!customer) return;

  const siId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  const si = siId ? await stripe.setupIntents.retrieve(siId) : null;
  const pm = typeof si?.payment_method === "string" ? si.payment_method : si?.payment_method?.id;
  if (!pm) return;
  await stripe.customers.update(customer, { invoice_settings: { default_payment_method: pm } });

  const pkg = await db.package.findUniqueOrThrow({ where: { id: client.packageId } });
  let price = pkg.stripePriceId;
  if (pkg.isCustom) {
    const slot = client.aceSlotId ? await db.aceSlot.findUnique({ where: { id: client.aceSlotId } }) : null;
    const amount = slot?.customMonthlyCents;
    if (!amount) return;
    price = (
      await stripe.prices.create(
        { currency: "usd", unit_amount: amount, recurring: { interval: "month" }, product_data: { name: `${pkg.name} — ${client.name}` } },
        { idempotencyKey: `bc-ace-price-${clientId}` },
      )
    ).id;
  }
  if (!price) return;

  const sub = await stripe.subscriptions.create(
    {
      customer,
      items: [{ price }],
      default_payment_method: pm,
      trial_end: Math.floor(client.acePrepaidUntil.getTime() / 1000) + 1,
      metadata: { kind: "ACE_CONTINUATION", clientId },
    },
    { idempotencyKey: `bc-ace-sub-${clientId}` },
  );
  await db.client.update({ where: { id: clientId }, data: { stripeSubscriptionId: sub.id, stripeCustomerId: customer } });
  await refreshClientStatus(clientId);
  await writeAudit({ actorId: null, action: "ace_subscription_started", entity: "Client", entityId: clientId, after: { subscriptionId: sub.id } });
}
