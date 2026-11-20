import type Stripe from "stripe";
import { db } from "@/lib/db";
import { packagePaidCents } from "@/domain/commission";
import type { WebhookDeps } from "@/stripe/webhook";

export type RefundInfo = { refundKey: string; refundCents: number; packageCents: number };

/**
 * charge.refunded: keep the invoice's refunded total current and report each refund once.
 * Package share = the retro-discount amount from our own refund metadata, otherwise proportional to what was paid.
 */
export async function onChargeRefunded(charge: Stripe.Charge, deps: WebhookDeps): Promise<void> {
  const stripeInvoiceId = deps.getInvoiceIdForCharge ? await deps.getInvoiceIdForCharge(charge) : null;
  if (!stripeInvoiceId) return;
  const inv = await db.invoice.findUnique({ where: { stripeInvoiceId } });
  if (!inv) return;

  const refunds = charge.refunds?.data ?? [];
  const fresh = refunds.filter((r) => !inv.seenRefundIds.includes(r.id));
  const pkg = packagePaidCents(inv);

  await db.invoice.update({
    where: { id: inv.id },
    data: { refundedCents: charge.amount_refunded, seenRefundIds: [...inv.seenRefundIds, ...fresh.map((r) => r.id)] },
  });

  for (const r of fresh) {
    const retro = r.metadata?.bc_retro_discount === "1" ? Number(r.metadata.discountCents) : NaN;
    const packageCents = Number.isFinite(retro)
      ? retro
      : inv.amountPaidCents > 0
        ? Math.floor((r.amount * pkg * 2 + inv.amountPaidCents) / (2 * inv.amountPaidCents))
        : 0;
    await deps.onRefund?.(inv.id, { refundKey: r.id, refundCents: r.amount, packageCents: Math.min(packageCents, pkg) });
  }
}
