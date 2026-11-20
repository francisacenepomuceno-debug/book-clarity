import { isCardFeeLine } from "@/stripe/lines";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { batchTotals } from "@/domain/ace";
import { startOfDayIn } from "@/domain/commission";
import { writeAudit } from "@/audit/log";
import { getPaidMethod } from "@/stripe/deps";
import { postAceCommissionsForBatch } from "@/ace/slots";
import type { ActionResult } from "@/billing/discounts";

const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";
const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that." };
const ACE_SETTING = "ace";

async function aceManager() {
  try {
    return await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

async function aceCustomerId(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: ACE_SETTING } });
  return (row?.value as { stripeCustomerId?: string } | null)?.stripeCustomerId ?? null;
}

export async function getAceCustomerId(): Promise<string | null> {
  return aceCustomerId();
}

/** Links ACE to its Stripe customer (the one batch invoices are sent to). */
export async function setAceCustomer(stripeCustomerId: string): Promise<ActionResult> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const id = stripeCustomerId.trim();
  if (!/^cus_[A-Za-z0-9]+$/.test(id)) return { ok: false, error: "Enter a Stripe customer ID (it starts with cus_)." };
  const c = await getStripe().customers.retrieve(id);
  if ((c as Stripe.DeletedCustomer).deleted) return { ok: false, error: "That Stripe customer was deleted." };
  const current = ((await db.setting.findUnique({ where: { key: ACE_SETTING } }))?.value ?? {}) as Record<string, unknown>;
  await db.setting.upsert({ where: { key: ACE_SETTING }, create: { key: ACE_SETTING, value: { ...current, stripeCustomerId: id } }, update: { value: { ...current, stripeCustomerId: id } } });
  await writeAudit({ actorId: actor.id, action: "ace_customer_set", entity: "Setting", entityId: ACE_SETTING, after: { stripeCustomerId: id } });
  return { ok: true };
}

type Line = { packageId: string; quantity: number; unitPriceCents: number };

export async function getAceContactEmail(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: ACE_SETTING } });
  return (row?.value as { contactEmail?: string } | null)?.contactEmail ?? null;
}

/** ACE's billing contact, who gets unpaid-batch reminders. */
export async function setAceContactEmail(email: string): Promise<ActionResult> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return { ok: false, error: "Enter a valid email address." };
  const current = ((await db.setting.findUnique({ where: { key: ACE_SETTING } }))?.value ?? {}) as Record<string, unknown>;
  await db.setting.upsert({ where: { key: ACE_SETTING }, create: { key: ACE_SETTING, value: { ...current, contactEmail: clean } }, update: { value: { ...current, contactEmail: clean } } });
  await writeAudit({ actorId: actor.id, action: "ace_contact_set", entity: "Setting", entityId: ACE_SETTING, after: { contactEmail: clean } });
  return { ok: true };
}

/**
 * Records an ACE purchase and creates its slots. Unless it was already paid outside the portal (historical),
 * ACE is sent a Stripe invoice payable by ACH or bank transfer.
 */
export async function createBatch(i: {
  purchasedOn: string;
  lines: Line[];
  note?: string;
  alreadyPaid?: { paidOn: string; method: "check" | "bank_transfer" | "ach" | "card"; reference: string };
  /** Bought before the portal: commission was settled outside it, so no months 1–6 lump sum is posted. */
  historical?: boolean;
}): Promise<ActionResult<{ batchId: string }>> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  if (i.historical && !i.alreadyPaid) return { ok: false, error: "A historical batch must be marked as already paid outside the portal." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.purchasedOn)) return { ok: false, error: "Pick the purchase date." };
  if (i.lines.length === 0 || i.lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1 || !Number.isInteger(l.unitPriceCents) || l.unitPriceCents < 1)) {
    return { ok: false, error: "Each line needs a quantity of at least 1 and a price per slot." };
  }
  const packages = await db.package.findMany({ where: { id: { in: i.lines.map((l) => l.packageId) } } });
  if (packages.length !== new Set(i.lines.map((l) => l.packageId)).size) return { ok: false, error: "Pick packages from the price list." };
  const customer = i.alreadyPaid ? null : await aceCustomerId();
  if (!i.alreadyPaid && !customer) return { ok: false, error: "Set ACE's Stripe customer in Settings first." };

  const batch = await db.$transaction(async (tx) => {
    const b = await tx.aceBatch.create({
      data: {
        purchasedAt: startOfDayIn(i.purchasedOn, tz()),
        note: i.note?.trim() || null,
        totalCents: batchTotals(i.lines),
        createdById: actor.id,
        historical: !!i.historical,
        ...(i.alreadyPaid
          ? {
              paidAt: startOfDayIn(i.alreadyPaid.paidOn, tz()),
              paidVia: "OUT_OF_BAND" as const,
              paymentMethod: i.alreadyPaid.method,
              paymentReference: i.alreadyPaid.reference.trim(),
            }
          : {}),
      },
    });
    await tx.aceBatchLine.createMany({ data: i.lines.map((l) => ({ ...l, batchId: b.id })) });
    await tx.aceSlot.createMany({ data: i.lines.flatMap((l) => Array.from({ length: l.quantity }, () => ({ batchId: b.id, packageId: l.packageId }))) });
    return b;
  });

  if (customer) {
    const issued = await issue(batch.id);
    if (!issued.ok) return issued;
  }
  await writeAudit({ actorId: actor.id, action: "ace_batch_created", entity: "AceBatch", entityId: batch.id, after: { lines: i.lines, totalCents: batch.totalCents, alreadyPaid: !!i.alreadyPaid, historical: !!i.historical } });
  return { ok: true, batchId: batch.id };
}

/**
 * Creates, finalizes and sends ACE's Stripe invoice for a batch. Safe to repeat: the invoice id is saved as soon
 * as it exists and every Stripe write uses a fixed idempotency key, so a retry finishes a half-done invoice.
 */
async function issue(batchId: string): Promise<ActionResult> {
  const batch = await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.paidAt) return { ok: false, error: "This batch is already paid." };
  const customer = await aceCustomerId();
  if (!customer) return { ok: false, error: "Set ACE's Stripe customer in Settings first." };
  const lines = await db.aceBatchLine.findMany({ where: { batchId }, orderBy: { id: "asc" } });
  const name = new Map((await db.package.findMany()).map((p) => [p.id, p.name]));
  const stripe = getStripe();
  // Each reissue (e.g. back to ACH after a card attempt) gets its own idempotency keys.
  const v = batch.invoiceVersion > 0 ? `-v${batch.invoiceVersion}` : "";
  try {
    let invoiceId = batch.stripeInvoiceId;
    if (!invoiceId) {
      const inv = await stripe.invoices.create(
        {
          customer,
          collection_method: "send_invoice",
          days_until_due: 14,
          auto_advance: false,
          metadata: { kind: "ACE_BATCH", batchId },
          payment_settings: {
            payment_method_types: ["us_bank_account", "customer_balance"],
            payment_method_options: { customer_balance: { funding_type: "bank_transfer", bank_transfer: { type: "us_bank_transfer" } } },
          },
        },
        { idempotencyKey: `bc-ace-batch-${batchId}${v}` },
      );
      invoiceId = inv.id!;
      await db.aceBatch.update({ where: { id: batchId }, data: { stripeInvoiceId: invoiceId } });
    }
    const live = await stripe.invoices.retrieve(invoiceId);
    if (live.status === "draft") {
      for (const [n, l] of lines.entries()) {
        await stripe.invoiceItems.create(
          {
            customer,
            invoice: invoiceId,
            amount: l.quantity * l.unitPriceCents,
            currency: "usd",
            description: `${l.quantity} × ${name.get(l.packageId)} — 6 months + onboarding (ACE)`,
            metadata: { kind: "ACE_BATCH", batchId },
          },
          { idempotencyKey: `bc-ace-batch-${batchId}${v}-line-${n}` },
        );
      }
      await stripe.invoices.finalizeInvoice(invoiceId);
    }
    if (!batch.invoiceSentAt) {
      await stripe.invoices.sendInvoice(invoiceId);
      await db.aceBatch.update({ where: { id: batchId }, data: { invoiceSentAt: new Date() } });
    }
    return { ok: true };
  } catch (e) {
    console.error(`[ace] batch ${batchId}: Stripe invoice failed:`, (e as Error).message);
    return { ok: false, error: "The batch was saved, but sending ACE's invoice failed. Open the batch and use \"Send invoice again\"." };
  }
}

/** Issues a fresh ACH / bank-transfer invoice for a batch (after the previous one was voided). */
export async function reissueAchInvoice(batchId: string): Promise<ActionResult> {
  await db.aceBatch.update({
    where: { id: batchId },
    data: { stripeInvoiceId: null, invoiceSentAt: null, invoiceVersion: { increment: 1 } },
  });
  return issue(batchId);
}

/** Retry for a batch whose invoice wasn't fully created or sent. */
export async function issueBatchInvoice(batchId: string): Promise<ActionResult> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const r = await issue(batchId);
  if (r.ok) await writeAudit({ actorId: actor.id, action: "ace_batch_invoice_sent", entity: "AceBatch", entityId: batchId });
  return r;
}

/** "Record payment received": a check, wire or other payment made outside Stripe. */
export async function recordBatchPayment(batchId: string, i: { paidOn: string; method: string; reference: string }): Promise<ActionResult> {
  const actor = await aceManager();
  if (!actor) return FORBIDDEN;
  const batch = await db.aceBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, error: "Batch not found." };
  if (batch.paidAt) return { ok: false, error: "This batch is already marked paid." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.paidOn) || !i.method.trim()) return { ok: false, error: "Enter the payment date and method." };

  if (batch.stripeInvoiceId) {
    await getStripe().invoices.pay(batch.stripeInvoiceId, { paid_out_of_band: true }, { idempotencyKey: `bc-ace-oob-${batchId}` });
  }
  const updated = await db.aceBatch.updateMany({
    where: { id: batchId, paidAt: null },
    data: { paidAt: startOfDayIn(i.paidOn, tz()), paidVia: "OUT_OF_BAND", paymentMethod: i.method.trim(), paymentReference: i.reference.trim() || null },
  });
  if (updated.count === 0) return { ok: false, error: "This batch is already marked paid." };
  await writeAudit({ actorId: actor.id, action: "ace_batch_paid_manual", entity: "AceBatch", entityId: batchId, after: i });
  await postAceCommissionsForBatch(batchId);
  return { ok: true };
}

/** Webhook: ACE paid the batch invoice through Stripe. */
export async function onBatchInvoicePaid(inv: Stripe.Invoice): Promise<void> {
  const batchId = inv.metadata?.batchId;
  // Paid out of band = "Record payment received" in the portal, which records the details itself.
  if (!batchId || (inv as unknown as { paid_out_of_band?: boolean }).paid_out_of_band) return;
  const paidAt = inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000) : new Date();
  const method = await getPaidMethod(inv).catch(() => null);
  const updated = await db.aceBatch.updateMany({
    where: { id: batchId, paidAt: null },
    data: { paidAt, paidVia: "STRIPE", paymentMethod: method?.type ?? null, cardFeeCents: (inv.lines?.data ?? []).filter(isCardFeeLine).reduce((n, l) => n + l.amount, 0) },
  });
  if (updated.count > 0) {
    await writeAudit({ actorId: null, action: "ace_batch_paid_stripe", entity: "AceBatch", entityId: batchId, after: { paidAt } });
    await postAceCommissionsForBatch(batchId);
  }
}

export type BatchSummary = {
  id: string;
  purchasedAt: Date;
  note: string | null;
  totalCents: number;
  paidAt: Date | null;
  paidVia: "STRIPE" | "OUT_OF_BAND" | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  stripeInvoiceId: string | null;
  invoiceSentAt: Date | null;
  historical: boolean;
  packages: { packageId: string; name: string; quantity: number; unitPriceCents: number; used: number; open: number }[];
};

async function summarize(batchIds: string[]): Promise<BatchSummary[]> {
  const [batches, lines, slots, packages] = await Promise.all([
    db.aceBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { purchasedAt: "desc" } }),
    db.aceBatchLine.findMany({ where: { batchId: { in: batchIds } } }),
    db.aceSlot.findMany({ where: { batchId: { in: batchIds } }, select: { batchId: true, packageId: true, clientId: true } }),
    db.package.findMany(),
  ]);
  const name = new Map(packages.map((p) => [p.id, p.name]));
  return batches.map((b) => ({
    ...b,
    packages: lines
      .filter((l) => l.batchId === b.id)
      .map((l) => {
        const s = slots.filter((x) => x.batchId === b.id && x.packageId === l.packageId);
        const used = s.filter((x) => x.clientId).length;
        return { packageId: l.packageId, name: name.get(l.packageId) ?? "?", quantity: l.quantity, unitPriceCents: l.unitPriceCents, used, open: s.length - used };
      }),
  }));
}

export async function listBatches(): Promise<BatchSummary[]> {
  await requirePermission("ace.manage");
  return summarize((await db.aceBatch.findMany({ select: { id: true } })).map((b) => b.id));
}

export async function batchDetail(batchId: string): Promise<BatchSummary | null> {
  await requirePermission("ace.manage");
  return (await summarize([batchId]))[0] ?? null;
}
