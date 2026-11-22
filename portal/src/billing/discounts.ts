import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { validateDiscount, type DiscountInput } from "@/domain/discount";
import { classifyProduct } from "@/stripe/catalog";
import { getPaidMethod } from "@/stripe/deps";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that." };

/** Monthly package price of a subscription (expanded products), excluding card-fee and onboarding items. */
function packagePriceCentsOf(sub: Stripe.Subscription): number {
  return sub.items.data.reduce((n, it) => {
    const product = it.price.product as Stripe.Product | string;
    const kind = classifyProduct(typeof product === "string" ? product : product.name).kind;
    return kind === "card_fee" || kind === "onboarding" ? n : n + (it.price.unit_amount ?? 0) * (it.quantity ?? 1);
  }, 0);
}

const MAX_REASON = 500; // Stripe metadata value limit

/** Owner-only: discount a client's subscription for N months. Replaces any current discount. */
export async function applyDiscount(clientId: string, input: DiscountInput, subscriptionId?: string): Promise<ActionResult<{ discountId: string }>> {
  let actor;
  try {
    actor = await requirePermission("discounts.apply");
  } catch (e) {
    if (e instanceof ForbiddenError) return FORBIDDEN;
    throw e;
  }
  if (input.reason && input.reason.trim().length > MAX_REASON) return { ok: false, error: `Reason must be ${MAX_REASON} characters or fewer.` };
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client?.stripeSubscriptionId) return { ok: false, error: "This client has no active subscription." };
  // A client can pay for several packages; the discount goes on the one chosen (the main one by default).
  const subId = subscriptionId ?? client.stripeSubscriptionId;
  if (subId !== client.stripeSubscriptionId && !(await db.clientSubscription.findFirst({ where: { stripeSubscriptionId: subId, clientId } }))) {
    return { ok: false, error: "That subscription isn't one of this client's." };
  }
  const stripe = getStripe();

  // One discount change per client at a time: the row lock serialises double submits and two Owners.
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price.product", "discounts"] });
      const v = validateDiscount({ ...input, monthlyPriceCents: packagePriceCentsOf(sub) });
      if (!v.ok) return v;

      const previous = await tx.discount.findFirst({ where: { clientId, replacedAt: null }, orderBy: { createdAt: "desc" } });
      const stripeDiscounts = (sub.discounts ?? []).map((d) => (typeof d === "string" ? { id: d } : { id: d.id, coupon: d.source?.coupon }));

      const couponId = `bc_${client.id}_${Date.now()}`;
      await stripe.coupons.create(
        {
          ...v.coupon,
          id: couponId,
          name: `Book Clarity discount (${input.months} mo)`,
          metadata: { reason: input.reason.trim(), clientId: client.id, createdBy: actor.id },
        },
        { idempotencyKey: `bc-coupon-${couponId}` },
      );
      await stripe.subscriptions.update(subId, { discounts: [{ coupon: couponId }] }, { idempotencyKey: `bc-sub-discount-${couponId}` });

      try {
        if (previous) await tx.discount.update({ where: { id: previous.id }, data: { replacedAt: new Date() } });
        const created = await tx.discount.create({
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
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            action: "discount_applied",
            entity: "Client",
            entityId: clientId,
            before: JSON.parse(JSON.stringify({ ...(previous ?? {}), stripeDiscounts })),
            after: JSON.parse(JSON.stringify(created)),
          },
        });
        return { ok: true as const, discountId: created.id };
      } catch (e) {
        // Stripe already has the discount; make the gap loud so it can be recorded by hand.
        console.error(`[discount] Stripe coupon ${couponId} applied to ${subId} but not recorded:`, (e as Error).message);
        throw e;
      }
    },
    { timeout: 30_000 },
  );
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
  if (input.reason.trim().length > MAX_REASON) return { ok: false, error: `Reason must be ${MAX_REASON} characters or fewer.` };
  const stripe = getStripe();

  return db.$transaction(
    async (tx) => {
      // Serialise retroactive discounts per invoice so their total can't exceed what was paid.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || inv.status !== "paid") return { ok: false as const, error: "Only paid invoices can be discounted after the fact." };

      const prior = await tx.auditLog.findMany({ where: { action: "discount_retroactive", entityId: inv.id } });
      const alreadyCents = prior.reduce((n, a) => n + Number((a.after as { amountCents?: number } | null)?.amountCents ?? 0), 0);
      const packagePaid = inv.amountPaidCents - inv.cardFeeCents;
      const remaining = packagePaid - alreadyCents;
      if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > remaining) {
        return { ok: false as const, error: `Amount must be more than $0 and no more than ${(remaining / 100).toFixed(2)} still refundable on this invoice.` };
      }
      // Refund the matching share of any card fee: fee × amount / package paid, rounded half-up.
      const feeCents =
        inv.cardFeeCents > 0 ? Math.floor((inv.cardFeeCents * input.amountCents * 2 + packagePaid) / (2 * packagePaid)) : 0;

      const stripeInvoice = await stripe.invoices.retrieve(inv.stripeInvoiceId);
      const paid = await getPaidMethod(stripeInvoice, stripe);
      if (!paid?.chargeId) return { ok: false as const, error: "This invoice was paid outside Stripe; refund it manually." };

      const n = prior.length + 1;
      const refund = await stripe.refunds.create(
        {
          charge: paid.chargeId,
          amount: input.amountCents + feeCents,
          metadata: {
            bc_retro_discount: "1",
            invoice: inv.stripeInvoiceId,
            discountCents: String(input.amountCents),
            feeCents: String(feeCents),
            reason: input.reason.trim(),
          },
        },
        { idempotencyKey: `bc-retro-${inv.id}-${n}` },
      );
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "discount_retroactive",
          entity: "Invoice",
          entityId: inv.id,
          after: { amountCents: input.amountCents, feeCents, refundId: refund.id, reason: input.reason.trim() },
        },
      });
      return { ok: true as const, refundId: refund.id };
    },
    { timeout: 30_000 },
  );
}
