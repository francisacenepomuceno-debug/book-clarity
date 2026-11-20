import type Stripe from "stripe";
import type { Invoice, InvoiceKind } from "@prisma/client";
import { db } from "@/lib/db";
import { idOf, isCardFeeLine, subscriptionIdOf } from "@/stripe/lines";

const fromTs = (t: number | null | undefined) => (t ? new Date(t * 1000) : null);

function kindOf(inv: Stripe.Invoice): InvoiceKind {
  if (subscriptionIdOf(inv)) return "SUBSCRIPTION";
  const k = inv.metadata?.kind;
  return k === "ONBOARDING" || k === "ACE_BATCH" ? k : "OTHER";
}

/** Invoice lifecycle order; events may arrive late, so a row never moves to a lower rank. */
const RANK: Record<string, number> = { draft: 0, open: 1, uncollectible: 2, paid: 3, void: 3 };
const rank = (s: string | null | undefined) => RANK[s ?? "draft"] ?? 0;

export type PaidMethod = { type: "card" | "us_bank_account" | string; funding: string | null; chargeId: string | null };

/** Upserts the portal's copy of a Stripe invoice. Returns null when the customer isn't a known client. */
export async function upsertInvoiceFromStripe(
  inv: Stripe.Invoice,
  extra: { failedNow?: boolean; paid?: PaidMethod | null } = {},
): Promise<Invoice | null> {
  const client = await db.client.findUnique({ where: { stripeCustomerId: idOf(inv.customer as string) ?? "" } });
  if (!client) {
    console.info(`[stripe] invoice ${inv.id}: customer not linked to a client yet, skipped`);
    return null;
  }
  const lines = inv.lines?.data ?? [];
  const cardFeeCents = lines.filter(isCardFeeLine).reduce((n, l) => n + l.amount, 0);
  const discountCents = (inv.total_discount_amounts ?? []).reduce((n, d) => n + d.amount, 0);

  const data = {
    clientId: client.id,
    status: inv.status ?? "draft",
    subtotalCents: inv.subtotal,
    discountCents,
    cardFeeCents,
    totalCents: inv.total,
    amountPaidCents: inv.amount_paid ?? 0,
    paidAt: fromTs(inv.status_transitions?.paid_at),
    periodStart: fromTs(inv.period_start) ?? new Date(),
    periodEnd: fromTs(inv.period_end) ?? new Date(),
    kind: kindOf(inv),
    ...(extra.paid ? { paymentMethodType: extra.paid.type, cardFunding: extra.paid.funding } : {}),
  };

  const existing = await db.invoice.findUnique({ where: { stripeInvoiceId: inv.id! } });
  const firstFailedAt = extra.failedNow && !existing?.firstFailedAt ? new Date() : undefined;
  if (existing && rank(existing.status) > rank(data.status)) {
    // Stale event (e.g. invoice.created delivered after invoice.paid): keep the newer state.
    return firstFailedAt ? db.invoice.update({ where: { id: existing.id }, data: { firstFailedAt } }) : existing;
  }

  return db.invoice.upsert({
    where: { stripeInvoiceId: inv.id! },
    create: { stripeInvoiceId: inv.id!, ...data, firstFailedAt: firstFailedAt ?? null },
    update: { ...data, ...(firstFailedAt ? { firstFailedAt } : {}) },
  });
}
