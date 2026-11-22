import type Stripe from "stripe";
import type { Client, PriceChange } from "@prisma/client";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { classifyProduct } from "@/stripe/catalog";
import { startOfDayIn } from "@/domain/commission";
import { firstBillOnOrAfter, noticeDueAt, PRICE_CHANGE_WINDOW_DAYS, PRICE_NOTICE_DAYS } from "@/domain/priceChange";
import { formatUsd } from "@/lib/money";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { planCardFeeLines } from "@/billing/pricing";
import type { ActionResult } from "@/billing/discounts";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const DAY = 86400_000;
const FORBIDDEN = { ok: false as const, error: "Only Owners and the Super Admin can change package prices." };
const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
const todayKey = (now: Date) => now.toLocaleDateString("en-CA", { timeZone: TZ });

async function owner() {
  try {
    return await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

/** The change still running for a package (scheduled, or started less than the move window ago). */
export async function currentPriceChange(packageId: string, now: Date = new Date()) {
  return db.priceChange.findFirst({
    where: { packageId, cancelledAt: null, effectiveAt: { gt: new Date(now.getTime() - PRICE_CHANGE_WINDOW_DAYS * DAY) } },
    orderBy: { createdAt: "desc" },
    include: { moves: true },
  });
}

/**
 * Owners / Super Admin: schedule a package price increase.
 * - New clients pay the new price from the start date (the package switches then).
 * - Current clients on the full list price move at their first bill on or after the start date, after a 30-day
 *   notice. Clients with a discount or a custom price are left as they are.
 * The new Stripe price is created now, on the same product as the current one.
 */
export async function schedulePriceIncrease(
  i: { packageId: string; newMonthlyCents: number; startsOn: string },
  now: Date = new Date(),
): Promise<ActionResult<{ priceChangeId: string }>> {
  const actor = await owner();
  if (!actor) return FORBIDDEN;
  const pkg = await db.package.findUnique({ where: { id: i.packageId } });
  if (!pkg) return { ok: false, error: "Package not found." };
  if (pkg.isCustom) return { ok: false, error: "Custom packages are priced per client, so they have no list price to change." };
  if (!pkg.stripePriceId) return { ok: false, error: `Add the ${pkg.name} package's Stripe price first, so current clients can be moved.` };
  if (!Number.isInteger(i.newMonthlyCents) || i.newMonthlyCents <= 0) return { ok: false, error: "Enter the new monthly price." };
  if (i.newMonthlyCents === pkg.monthlyPriceCents) return { ok: false, error: `${pkg.name} is already ${formatUsd(pkg.monthlyPriceCents)}/month.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startsOn)) return { ok: false, error: "Choose the date the new price starts." };
  const effectiveAt = startOfDayIn(i.startsOn, TZ);
  const earliest = startOfDayIn(todayKey(new Date(now.getTime() + PRICE_NOTICE_DAYS * DAY)), TZ);
  if (Number.isNaN(effectiveAt.getTime()) || effectiveAt < earliest) {
    return { ok: false, error: `The start date must be at least ${PRICE_NOTICE_DAYS} days away (${fmtDay(earliest)} or later), so every client gets ${PRICE_NOTICE_DAYS} days' notice.` };
  }
  if (await currentPriceChange(pkg.id, now)) return { ok: false, error: `${pkg.name} already has a price change in progress. Cancel it first to schedule a different one.` };

  const stripe = getStripe();
  const old = await stripe.prices.retrieve(pkg.stripePriceId);
  const product = typeof old.product === "string" ? old.product : old.product.id;
  const price = await stripe.prices.create(
    {
      product,
      currency: old.currency,
      unit_amount: i.newMonthlyCents,
      recurring: { interval: old.recurring?.interval ?? "month", interval_count: old.recurring?.interval_count ?? 1 },
      nickname: `${pkg.name} from ${i.startsOn}`,
      metadata: { bc_package_id: pkg.id, bc_starts_on: i.startsOn },
    },
    { idempotencyKey: `bc-price-change-${pkg.id}-${i.newMonthlyCents}-${i.startsOn}` },
  );
  const change = await db.priceChange.create({
    data: {
      packageId: pkg.id,
      oldMonthlyCents: pkg.monthlyPriceCents,
      newMonthlyCents: i.newMonthlyCents,
      oldStripePriceId: pkg.stripePriceId,
      newStripePriceId: price.id,
      effectiveAt,
      createdById: actor.id,
    },
  });
  await writeAudit({ actorId: actor.id, action: "price_change_scheduled", entity: "Package", entityId: pkg.id, after: change });
  return { ok: true, priceChangeId: change.id };
}

/** Owners / Super Admin: cancel a scheduled increase, as long as no client has been moved to the new price yet. */
export async function cancelPriceIncrease(priceChangeId: string, now: Date = new Date()): Promise<ActionResult> {
  const actor = await owner();
  if (!actor) return FORBIDDEN;
  const c = await db.priceChange.findUnique({ where: { id: priceChangeId }, include: { moves: true } });
  if (!c || c.cancelledAt) return { ok: false, error: "This price change isn't scheduled." };
  if (c.packageSwitchedAt || c.moves.length > 0) {
    return { ok: false, error: "This price change has already started (the package or some clients are on the new price), so it can't be cancelled here." };
  }
  await db.priceChange.update({ where: { id: c.id }, data: { cancelledAt: now, cancelledById: actor.id } });
  await writeAudit({ actorId: actor.id, action: "price_change_cancelled", entity: "Package", entityId: c.packageId, before: c });
  return { ok: true };
}

const productName = (it: Stripe.SubscriptionItem) => {
  const p = it.price.product as Stripe.Product | string;
  return typeof p === "string" ? p : p.name;
};

type Outcome = "noticed" | "moved" | "waiting" | "not_eligible";

/** One current client: send the notice when it's due, and move them once their next bill is the first new-price one. */
async function processClient(change: PriceChange & { package: { name: string } }, client: Client, now: Date, stripe: Stripe): Promise<Outcome[]> {
  const sub = await stripe.subscriptions.retrieve(client.stripeSubscriptionId!, {
    expand: ["items.data.price.product", "discounts", "default_payment_method", "customer.invoice_settings.default_payment_method"],
  });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return ["not_eligible"];
  const lines = sub.items.data.filter((it) => {
    const k = classifyProduct(productName(it)).kind;
    return k !== "card_fee" && k !== "onboarding";
  });
  if (lines.length !== 1) return ["not_eligible"];
  const item = lines[0];
  // Only clients paying the full list price move; a discount or a custom price is left for the Owners to review.
  const monthly = item.price.recurring?.interval === "month" && (item.price.recurring.interval_count ?? 1) === 1;
  if (!monthly || item.price.unit_amount !== change.oldMonthlyCents || (item.quantity ?? 1) !== 1 || (sub.discounts?.length ?? 0) > 0) return ["not_eligible"];

  const periodEnd = new Date(((item as { current_period_end?: number }).current_period_end ?? (sub as { current_period_end?: number }).current_period_end ?? 0) * 1000);
  if (!periodEnd.getTime()) return ["not_eligible"];
  const startsOn = firstBillOnOrAfter(periodEnd, change.effectiveAt);
  const out: Outcome[] = [];
  const key = `price-increase:${change.id}:${client.id}`;

  if (now >= noticeDueAt(startsOn)) {
    const t = templates.priceIncrease({
      name: client.name,
      packageName: change.package.name,
      oldAmount: formatUsd(change.oldMonthlyCents),
      newAmount: formatUsd(change.newMonthlyCents),
      startsOn: fmtDay(startsOn),
    });
    const r = await sendNotice({ key, kind: "price_increase", clientId: client.id, to: { name: client.name, email: client.email, phone: client.phone, ghlContactId: client.ghlContactId }, email: { subject: t.subject, html: t.html }, sms: t.sms });
    if (r !== "DUPLICATE") out.push("noticed");
  }

  // The next bill is the first one on or after the start date: switch now, so it's invoiced at the new price.
  // Only after the notice has gone (or been recorded as held while notices are off before launch).
  const noticed = await db.notification.findUnique({ where: { key } });
  if (startsOn.getTime() === periodEnd.getTime() && noticed && noticed.status !== "PENDING") {
    const fee = await planCardFeeLines(sub.items.data.filter((it) => classifyProduct(productName(it)).kind === "card_fee"), sub, change.newMonthlyCents);
    const feeItems: Stripe.SubscriptionUpdateParams.Item[] = [];
    for (const f of fee.changes) {
      if (f.action === "remove") feeItems.push({ id: f.item.id, deleted: true });
      else {
        const product = typeof f.item.price.product === "string" ? f.item.price.product : f.item.price.product.id;
        const p = await stripe.prices.create(
          { product, currency: f.item.price.currency, unit_amount: f.cents, recurring: { interval: "month", interval_count: 1 }, nickname: `3% card fee on ${formatUsd(change.newMonthlyCents)}` },
          { idempotencyKey: `bc-card-fee-price-${product}-${f.cents}` },
        );
        feeItems.push({ id: f.item.id, price: p.id, quantity: 1 });
      }
    }
    await stripe.subscriptions.update(
      sub.id,
      { items: [{ id: item.id, price: change.newStripePriceId, quantity: 1 }, ...feeItems], proration_behavior: "none" },
      { idempotencyKey: `bc-price-change-move-${change.id}-${sub.id}` },
    );
    await db.priceChangeMove.create({
      data: { priceChangeId: change.id, clientId: client.id, subscriptionId: sub.id, fromPriceId: item.price.id, fromCents: item.price.unit_amount ?? 0, startsOn },
    });
    await writeAudit({
      actorId: null,
      action: "price_change_applied",
      entity: "Client",
      entityId: client.id,
      before: { priceId: item.price.id, unitAmount: item.price.unit_amount },
      after: { priceId: change.newStripePriceId, unitAmount: change.newMonthlyCents, startsOn, cardFeeLines: fee.changes.map((c) => ({ id: c.item.id, action: c.action, cents: c.cents ?? null })) },
    });
    out.push("moved");
  }
  return out.length ? out : ["waiting"];
}

/**
 * Daily: runs every price change in progress.
 * - On the start date the package itself switches (list price and Stripe price), so new clients get the new price.
 * - Current clients are noticed 30 days before their first new-price bill and moved just before it.
 */
export async function runPriceChanges(now: Date = new Date()) {
  const changes = await db.priceChange.findMany({
    where: { cancelledAt: null, effectiveAt: { gt: new Date(now.getTime() - PRICE_CHANGE_WINDOW_DAYS * DAY) } },
    include: { package: true, moves: true },
  });
  const counts = { switched: 0, noticed: 0, moved: 0, failed: 0 };
  if (!changes.length) return counts;
  const stripe = getStripe();
  for (const change of changes) {
    if (!change.packageSwitchedAt && now >= change.effectiveAt) {
      const before = change.package;
      await db.package.update({ where: { id: change.packageId }, data: { monthlyPriceCents: change.newMonthlyCents, stripePriceId: change.newStripePriceId } });
      await db.priceChange.update({ where: { id: change.id }, data: { packageSwitchedAt: now } });
      await writeAudit({ actorId: null, action: "package_price_switched", entity: "Package", entityId: change.packageId, before, after: { monthlyPriceCents: change.newMonthlyCents, stripePriceId: change.newStripePriceId } });
      counts.switched++;
    }
    const moved = new Set(change.moves.map((m) => m.clientId));
    const clients = await db.client.findMany({ where: { packageId: change.packageId, stripeSubscriptionId: { not: null }, endedAt: null } });
    for (const client of clients.filter((c) => !moved.has(c.id))) {
      try {
        const r = await processClient(change, client, now, stripe);
        if (r.includes("noticed")) counts.noticed++;
        if (r.includes("moved")) counts.moved++;
      } catch (e) {
        counts.failed++;
        console.error(`[price-change] ${change.id} client ${client.id}:`, (e as Error).message);
      }
    }
  }
  return counts;
}
