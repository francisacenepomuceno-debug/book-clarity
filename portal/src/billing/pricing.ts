import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission, type Permission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { classifyProduct } from "@/stripe/catalog";
import { formatUsd } from "@/lib/money";
import type { ActionResult } from "@/billing/discounts";
import { getFeeSettings } from "@/settings/cardFee";

const FORBIDDEN = { ok: false as const, error: "Only Owners and the Super Admin can do that." };

async function actorWith(p: Permission) {
  try {
    return await requirePermission(p);
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

const productName = (it: Stripe.SubscriptionItem) => {
  const p = it.price.product as Stripe.Product | string;
  return typeof p === "string" ? p : p.name;
};

/** Owners / Super Admin: link a client to a portal package by hand. Stripe sync never overwrites a link. */
export async function linkClientPackage(clientId: string, packageId: string | null): Promise<ActionResult> {
  const actor = await actorWith("ace.manage");
  if (!actor) return FORBIDDEN;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true, packageId: true } });
  if (!client) return { ok: false, error: "Client not found." };
  if (packageId && !(await db.package.findUnique({ where: { id: packageId } }))) return { ok: false, error: "That package doesn't exist." };
  if (client.packageId === packageId) return { ok: true };
  await db.client.update({ where: { id: clientId }, data: { packageId } });
  await writeAudit({ actorId: actor.id, action: "client_package_linked", entity: "Client", entityId: clientId, before: { packageId: client.packageId }, after: { packageId } });
  return { ok: true };
}

/**
 * Owners / Super Admin: put a discounted client back on their package's list price.
 * The package line of the Stripe subscription moves to the package's Stripe price and any Stripe discount is removed.
 * Nothing is charged now: the new price applies from the next monthly bill (no proration).
 */
export async function revertToListPrice(clientId: string): Promise<ActionResult<{ note?: string }>> {
  const actor = await actorWith("discounts.apply");
  if (!actor) return FORBIDDEN;
  const client = await db.client.findUnique({ where: { id: clientId }, include: { package: true } });
  if (!client?.stripeSubscriptionId) return { ok: false, error: "This client has no active Stripe subscription." };
  const pkg = client.package;
  if (!pkg) return { ok: false, error: "Link this client to a package first, so the portal knows the original price." };
  if (pkg.isCustom) return { ok: false, error: "Custom packages have no list price to go back to." };
  if (!pkg.stripePriceId) return { ok: false, error: `The ${pkg.name} package has no Stripe price yet. Add it on the Packages page first.` };

  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(client.stripeSubscriptionId, {
    expand: ["items.data.price.product", "discounts", "default_payment_method", "customer.invoice_settings.default_payment_method"],
  });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { ok: false, error: "This subscription has ended." };
  const packageItems = sub.items.data.filter((it) => {
    const k = classifyProduct(productName(it)).kind;
    return k !== "card_fee" && k !== "onboarding";
  });
  if (packageItems.length !== 1) {
    return { ok: false, error: `This subscription has ${packageItems.length} package lines, so it can't be changed automatically. Please change it in Stripe.` };
  }
  const item = packageItems[0];
  const feeItems = sub.items.data.filter((it) => classifyProduct(productName(it)).kind === "card_fee");
  const before = {
    priceId: item.price.id,
    unitAmount: item.price.unit_amount,
    quantity: item.quantity,
    discounts: (sub.discounts ?? []).map((d) => (typeof d === "string" ? d : d.id)),
    cardFeeLines: feeItems.map((f) => ({ id: f.id, priceId: f.price.id, unitAmount: f.price.unit_amount })),
  };
  const alreadyList = item.price.id === pkg.stripePriceId && (item.quantity ?? 1) === 1 && before.discounts.length === 0;
  if (alreadyList) return { ok: false, error: `${client.name} is already on the ${pkg.name} list price.` };

  // Older subscriptions carry the 3% card fee as a fixed-amount line, which wouldn't follow the new price.
  const fee = await planCardFeeLines(feeItems, sub, pkg.monthlyPriceCents);
  const feeChanges: Stripe.SubscriptionUpdateParams.Item[] = [];
  for (const f of fee.changes) {
    if (f.action === "remove") feeChanges.push({ id: f.item.id, deleted: true });
    else {
      const product = typeof f.item.price.product === "string" ? f.item.price.product : f.item.price.product.id;
      const price = await stripe.prices.create(
        {
          product,
          currency: f.item.price.currency,
          unit_amount: f.cents,
          recurring: { interval: f.item.price.recurring?.interval ?? "month", interval_count: f.item.price.recurring?.interval_count ?? 1 },
          nickname: `3% card fee on ${formatUsd(pkg.monthlyPriceCents)}`,
        },
        { idempotencyKey: `bc-card-fee-price-${product}-${f.cents}` },
      );
      feeChanges.push({ id: f.item.id, price: price.id, quantity: 1 });
    }
  }

  await stripe.subscriptions.update(
    sub.id,
    { items: [{ id: item.id, price: pkg.stripePriceId, quantity: 1 }, ...feeChanges], discounts: [], proration_behavior: "none" },
    { idempotencyKey: `bc-revert-price-${sub.id}-${item.price.id}-${before.discounts.join(",")}-${fee.key}` },
  );
  // The portal's own discount records end here too.
  await db.discount.updateMany({ where: { clientId, replacedAt: null }, data: { replacedAt: new Date() } });
  await writeAudit({
    actorId: actor.id,
    action: "price_reverted_to_list",
    entity: "Client",
    entityId: clientId,
    before,
    after: { priceId: pkg.stripePriceId, unitAmount: pkg.monthlyPriceCents, quantity: 1, discounts: [], cardFeeLines: fee.changes.map((c) => ({ id: c.item.id, action: c.action, cents: c.cents ?? null, why: c.why })) },
  });
  const note = fee.changes.length ? fee.changes.map((c) => c.why).join(" ") : undefined;
  return { ok: true, note };
}

type FeeChange = { item: Stripe.SubscriptionItem; action: "remove" | "update"; cents?: number; why: string };

/**
 * What to do with fixed-amount card-fee lines when the price changes:
 * - removed when the client doesn't pay by credit card (no fee applies), or when the portal adds the fee to each
 *   invoice itself (card fee switched on at launch), so it isn't charged twice;
 * - otherwise set to the fee rate on the new price.
 */
async function planCardFeeLines(items: Stripe.SubscriptionItem[], sub: Stripe.Subscription, listCents: number): Promise<{ changes: FeeChange[]; key: string }> {
  if (!items.length) return { changes: [], key: "nofee" };
  const settings = await getFeeSettings();
  const customer = typeof sub.customer === "object" ? (sub.customer as Stripe.Customer) : null;
  const pm = (sub.default_payment_method ?? customer?.invoice_settings?.default_payment_method ?? null) as Stripe.PaymentMethod | string | null;
  const credit = !!pm && typeof pm === "object" && pm.type === "card" && pm.card?.funding === "credit";
  const cents = Math.round((listCents * settings.rateBasisPoints) / 10_000);
  const changes: FeeChange[] = items.map((item) => {
    const old = formatUsd((item.price.unit_amount ?? 0) * (item.quantity ?? 1));
    if (!credit) return { item, action: "remove", why: `Removed the fixed ${old} card-fee line: this client doesn't pay by credit card.` };
    if (settings.enabled) return { item, action: "remove", why: `Removed the fixed ${old} card-fee line: the portal now adds the card fee to each invoice.` };
    return { item, action: "update", cents, why: `Changed the fixed card-fee line from ${old} to ${formatUsd(cents)} (${settings.rateBasisPoints / 100}% of ${formatUsd(listCents)}).` };
  });
  return { changes, key: changes.map((c) => `${c.item.id}:${c.action}:${c.cents ?? 0}`).join(",") };
}
