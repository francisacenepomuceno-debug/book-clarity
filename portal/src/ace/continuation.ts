import type Stripe from "stripe";
import { signLink, verifyLink } from "@/lib/links";
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

/**
 * ACE clients within 60 days of the end of their prepaid period (or past it) who have no subscription yet,
 * including ones whose end an Owner confirmed but whose last day hasn't passed (they can still be won back).
 */
export async function dueForContinuation(now: Date = new Date()) {
  const rows = await db.client.findMany({
    where: {
      type: "ACE",
      OR: [{ endedAt: null }, { endedAt: { gt: now } }],
      stripeSubscriptionId: null,
      acePrepaidUntil: { not: null, lte: new Date(now.getTime() + CONTINUATION_NOTICE_DAYS * 86400_000) },
    },
    orderBy: { acePrepaidUntil: "asc" },
  });
  return rows.map((c) => ({
    clientId: c.id,
    name: c.name,
    prepaidUntil: c.acePrepaidUntil!,
    decision: c.continuationDecision,
    clientAnswer: c.clientAnswer,
    clientAnsweredAt: c.clientAnsweredAt,
  }));
}

export function continuationToken(clientId: string): string {
  return signLink("ace-continue", clientId);
}

/** The client wants to continue: record it and return the link to send them for setting up autopay. */
export async function markContinuing(clientId: string, baseUrl: string): Promise<ActionResult<{ setupUrl: string }>> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client || client.type !== "ACE" || !client.aceSlotId) return { ok: false, error: "This isn't an ACE client." };
  if (client.stripeSubscriptionId) return { ok: false, error: "This client already has autopay set up." };
  const pkg = client.packageId ? await db.package.findUnique({ where: { id: client.packageId } }) : null;
  if (!pkg) return { ok: false, error: "This client has no package." };
  if (!pkg.isCustom && !pkg.stripePriceId) return { ok: false, error: "Link this package to a Stripe price in Settings → Packages." };

  if (client.endedAt && client.endedAt <= new Date()) return { ok: false, error: "This client's service has already ended." };
  await ensureCustomer(client);
  // Winning a client back undoes a confirmed end, up to their last prepaid day.
  await db.client.update({ where: { id: clientId }, data: { continuationDecision: "CONTINUING", endedAt: null } });
  await refreshClientStatus(clientId);
  await writeAudit({ actorId: actor.id, action: "ace_continuing", entity: "Client", entityId: clientId });
  return { ok: true, setupUrl: `${baseUrl}/continue/${continuationToken(clientId)}` };
}

async function ensureCustomer(client: { id: string; name: string; email: string | null; stripeCustomerId: string | null }): Promise<string> {
  if (client.stripeCustomerId) return client.stripeCustomerId;
  const cus = await getStripe().customers.create(
    { name: client.name, email: client.email ?? undefined, metadata: { clientId: client.id } },
    { idempotencyKey: `bc-ace-cus-${client.id}` },
  );
  await db.client.update({ where: { id: client.id }, data: { stripeCustomerId: cus.id } });
  return cus.id;
}

const LINK_INACTIVE = "This link is no longer active. If you'd like to continue with Book Clarity, please contact us.";

/**
 * Public Yes/No answer from the client's link. The link works until the last prepaid day (or later if an Owner
 * marked them continuing), unless an Owner confirmed the end. "No" ends nothing: Owners follow up and the client
 * can still say Yes until the last day.
 */
export async function answerContinuation(
  token: string,
  answer: "YES" | "NO",
  baseUrl: string,
  now: Date = new Date(),
): Promise<{ url?: string; message?: string; error?: string }> {
  const clientId = verifyLink("ace-continue", token);
  const client = clientId ? await db.client.findUnique({ where: { id: clientId } }) : null;
  if (!client || client.type !== "ACE" || !client.aceSlotId) return { error: "This link isn't valid. Please use the link Book Clarity sent you." };
  const beforeEnd = client.acePrepaidUntil !== null && now <= client.acePrepaidUntil;
  if (client.stripeSubscriptionId) return { message: "You're all set: your autopay with Book Clarity is already in place. Thank you!" };
  if (client.continuationDecision === "ENDING" || !(beforeEnd || client.continuationDecision === "CONTINUING")) return { error: LINK_INACTIVE };

  if (answer === "NO") {
    await db.client.update({ where: { id: client.id }, data: { clientAnswer: "NO", clientAnsweredAt: now } });
    await writeAudit({ actorId: null, action: "ace_client_answered_no", entity: "Client", entityId: client.id });
    return {
      message:
        "Thank you for letting us know. Your service continues until the end of your ACE period. If you change your mind before then, just use this link again or reply to our message.",
    };
  }
  await ensureCustomer(client);
  await db.client.update({ where: { id: client.id }, data: { clientAnswer: "YES", clientAnsweredAt: now, continuationDecision: "CONTINUING" } });
  await refreshClientStatus(client.id);
  await writeAudit({ actorId: null, action: "ace_client_answered_yes", entity: "Client", entityId: client.id });
  const r = await startSetupFromToken(token, baseUrl);
  return "url" in r ? { url: r.url } : { error: r.error };
}

/** Public: the client opened their link. Returns a fresh Stripe setup page, or why the link no longer works. */
export async function startSetupFromToken(token: string, baseUrl: string): Promise<{ url: string } | { error: string }> {
  const clientId = verifyLink("ace-continue", token);
  if (!clientId) return { error: "This link isn't valid. Please use the link Book Clarity sent you." };
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client || client.continuationDecision !== "CONTINUING" || client.endedAt || client.stripeSubscriptionId || !client.stripeCustomerId) {
    return { error: "This link is no longer active. If you'd like to continue with Book Clarity, please contact us." };
  }
  const session = await getStripe().checkout.sessions.create({
    mode: "setup",
    customer: client.stripeCustomerId,
    currency: "usd",
    allowed_payment_method_types: ["card", "us_bank_account"],
    metadata: { kind: "ACE_CONTINUATION", clientId },
    success_url: `${baseUrl}/setup-complete`,
    cancel_url: `${baseUrl}/setup-complete?cancelled=1`,
  });
  await db.client.update({ where: { id: clientId }, data: { aceSetupSessionId: session.id } });
  return { url: session.url! };
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
  if (client.aceSetupSessionId) {
    // Close any setup page the client still has open so it can't start autopay.
    await getStripe().checkout.sessions.expire(client.aceSetupSessionId).catch(() => undefined);
  }
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
  // Only when an Owner said the client is continuing and hasn't since marked them as not continuing.
  if (client.continuationDecision !== "CONTINUING" || client.endedAt) return;
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
      // First charge the day after the prepaid period; if that has already passed, billing starts now.
      ...(client.acePrepaidUntil > new Date() ? { trial_end: Math.floor(client.acePrepaidUntil.getTime() / 1000) + 1 } : {}),
      metadata: { kind: "ACE_CONTINUATION", clientId },
    },
    { idempotencyKey: `bc-ace-sub-${clientId}` },
  );
  await db.client.update({ where: { id: clientId }, data: { stripeSubscriptionId: sub.id, stripeCustomerId: customer } });
  await refreshClientStatus(clientId);
  await writeAudit({ actorId: null, action: "ace_subscription_started", entity: "Client", entityId: clientId, after: { subscriptionId: sub.id } });
}
