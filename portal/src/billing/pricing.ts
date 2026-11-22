import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission, type Permission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { classifyProduct } from "@/stripe/catalog";
import { formatUsd } from "@/lib/money";
import type { ActionResult } from "@/billing/discounts";

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
  const sub = await stripe.subscriptions.retrieve(client.stripeSubscriptionId, { expand: ["items.data.price.product", "discounts"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { ok: false, error: "This subscription has ended." };
  const packageItems = sub.items.data.filter((it) => {
    const k = classifyProduct(productName(it)).kind;
    return k !== "card_fee" && k !== "onboarding";
  });
  if (packageItems.length !== 1) {
    return { ok: false, error: `This subscription has ${packageItems.length} package lines, so it can't be changed automatically. Please change it in Stripe.` };
  }
  const item = packageItems[0];
  const before = { priceId: item.price.id, unitAmount: item.price.unit_amount, quantity: item.quantity, discounts: (sub.discounts ?? []).map((d) => (typeof d === "string" ? d : d.id)) };
  const alreadyList = item.price.id === pkg.stripePriceId && (item.quantity ?? 1) === 1 && before.discounts.length === 0;
  if (alreadyList) return { ok: false, error: `${client.name} is already on the ${pkg.name} list price.` };

  await stripe.subscriptions.update(
    sub.id,
    { items: [{ id: item.id, price: pkg.stripePriceId, quantity: 1 }], discounts: [], proration_behavior: "none" },
    { idempotencyKey: `bc-revert-price-${sub.id}-${item.price.id}-${before.discounts.join(",")}` },
  );
  // The portal's own discount records end here too.
  await db.discount.updateMany({ where: { clientId, replacedAt: null }, data: { replacedAt: new Date() } });
  await writeAudit({
    actorId: actor.id,
    action: "price_reverted_to_list",
    entity: "Client",
    entityId: clientId,
    before,
    after: { priceId: pkg.stripePriceId, unitAmount: pkg.monthlyPriceCents, quantity: 1, discounts: [] },
  });

  // Older subscriptions carry the 3% card fee as a fixed-amount item; it doesn't follow the new price by itself.
  const fixedFee = sub.items.data.find((it) => classifyProduct(productName(it)).kind === "card_fee");
  const note = fixedFee
    ? `This subscription also has a fixed card-fee line of ${formatUsd((fixedFee.price.unit_amount ?? 0) * (fixedFee.quantity ?? 1))}. Update it in Stripe to 3% of ${formatUsd(pkg.monthlyPriceCents)} if this client pays by credit card.`
    : undefined;
  return { ok: true, note };
}
