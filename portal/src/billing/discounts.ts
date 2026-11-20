import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { validateDiscount, type DiscountInput } from "@/domain/discount";
import { classifyProduct } from "@/stripe/catalog";
import { getPaidMethod } from "@/stripe/deps";
import { writeAudit } from "@/audit/log";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that." };

/** Monthly package price from the live subscription, excluding card-fee and onboarding items. */
async function packagePriceCents(stripe: Stripe, subId: string): Promise<number> {
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product"] });
  return sub.items.data.reduce((n, it) => {
    const product = it.price.product as Stripe.Product | string;
    const kind = classifyProduct(typeof product === "string" ? product : product.name).kind;
    return kind === "card_fee" || kind === "onboarding" ? n : n + (it.price.unit_amount ?? 0) * (it.quantity ?? 1);
  }, 0);
}

/** Owner-only: discount a client's subscription for N months. Replaces any current discount. */
export async function applyDiscount(clientId: string, input: DiscountInput): Promise<ActionResult<{ discountId: string }>> {
  let actor;
  try {
    actor = await requirePermission("discounts.apply");
  } catch (e) {
    if (e instanceof ForbiddenError) return FORBIDDEN;
    throw e;
  }
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client?.stripeSubscriptionId) return { ok: false, error: "This client has no active subscription." };

  const stripe = getStripe();
  const monthlyPriceCents = await packagePriceCents(stripe, client.stripeSubscriptionId);
  const v = validateDiscount({ ...input, monthlyPriceCents });
  if (!v.ok) return v;

  const couponId = `bc_${client.id}_${Date.now()}`;
  await stripe.coupons.create({
    ...v.coupon,
    id: couponId,
    name: `Book Clarity discount (${input.months} mo)`,
    metadata: { reason: input.reason.trim(), clientId: client.id, createdBy: actor.id },
  });
  await stripe.subscriptions.update(client.stripeSubscriptionId, { discounts: [{ coupon: couponId }] });

  const previous = await db.discount.findFirst({ where: { clientId, replacedAt: null }, orderBy: { createdAt: "desc" } });
  const created = await db.$transaction(async (tx) => {
    if (previous) await tx.discount.update({ where: { id: previous.id }, data: { replacedAt: new Date() } });
    return tx.discount.create({
      data: {
        clientId,
        kind: input.kind,
        percentOff: input.kind === "PERCENT" ? input.percentOff : null,
        amountOffCents: input.kind === "AMOUNT" ? input.amountOffCents : null,
        months: input.months,
        reason: input.reason.trim(),
        stripeCouponId: couponId,
        createdById: actor.id,
      },
    });
  });
  await writeAudit({ actorId: actor.id, action: "discount_applied", entity: "Client", entityId: clientId, before: previous, after: created });
  return { ok: true, discountId: created.id };
}

/** Owner-only: give a discount on an invoice that was already paid, as a partial refund (spec §7.2, D3). */
export async function applyRetroactiveDiscount(
  invoiceId: string,
  input: { amountCents: number; reason: string },
): Promise<ActionResult<{ refundId: string }>> {
  let actor;
  try {
    actor = await requirePermission("discounts.apply");
  } catch (e) {
    if (e instanceof ForbiddenError) return FORBIDDEN;
    throw e;
  }
  if (!input.reason?.trim()) return { ok: false, error: "A reason is required." };
  const inv = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv || inv.status !== "paid") return { ok: false, error: "Only paid invoices can be discounted after the fact." };

  const packagePaid = inv.amountPaidCents - inv.cardFeeCents;
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > packagePaid) {
    return { ok: false, error: "Amount must be more than $0 and no more than the package amount paid." };
  }
  // Refund the matching share of any card fee: fee × amount / package paid, rounded half-up.
  const feeCents = inv.cardFeeCents > 0 ? Math.floor((inv.cardFeeCents * input.amountCents * 2 + packagePaid) / (2 * packagePaid)) : 0;

  const stripe = getStripe();
  const stripeInvoice = await stripe.invoices.retrieve(inv.stripeInvoiceId);
  const paid = await getPaidMethod(stripeInvoice, stripe);
  if (!paid?.chargeId) return { ok: false, error: "This invoice was paid outside Stripe; refund it manually." };

  const refund = await stripe.refunds.create({
    charge: paid.chargeId,
    amount: input.amountCents + feeCents,
    metadata: {
      bc_retro_discount: "1",
      invoice: inv.stripeInvoiceId,
      discountCents: String(input.amountCents),
      feeCents: String(feeCents),
      reason: input.reason.trim(),
    },
  });
  await writeAudit({
    actorId: actor.id,
    action: "discount_retroactive",
    entity: "Invoice",
    entityId: inv.id,
    after: { amountCents: input.amountCents, feeCents, refundId: refund.id, reason: input.reason.trim() },
  });
  return { ok: true, refundId: refund.id };
}
