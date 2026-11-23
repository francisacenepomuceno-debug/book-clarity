import type Stripe from "stripe";
import type { Client } from "@prisma/client";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { startOfDayIn } from "@/domain/commission";
import { formatUsd } from "@/lib/money";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import { recordPaymentCommission } from "@/commissions/engine";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import type { ActionResult } from "@/billing/discounts";

/**
 * Clients who pay outside Stripe (Zelle, check, PayPal, bill.com, wire, cash…). Their Stripe subscription still
 * sets the billing dates and amounts; the Super Admin is reminded 7 days before, 1 day before and on each due date,
 * and marks each bill paid by hand (the Stripe invoice is then marked "paid out of band"). Clients get no automatic
 * payment emails and are never auto-suspended.
 */
export const OUTSIDE_METHODS = ["Zelle", "Check", "PayPal", "Bill.com", "Wire transfer", "ACH (bank to bank)", "Cash", "Other"] as const;
export const OUTSIDE_REMINDER_DAYS = [7, 1, 0] as const;

const TZ = () => process.env.BUSINESS_TZ ?? "America/New_York";
const DAY = 86400_000;
const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ() });
const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ(), month: "short", day: "numeric", year: "numeric" });
/** Whole days from today to the due day, in the business timezone (0 = due today, negative = overdue). */
export const daysUntil = (due: Date, now: Date) => Math.round((startOfDayIn(ymd(due), TZ()).getTime() - startOfDayIn(ymd(now), TZ()).getTime()) / DAY);

async function staff() {
  try {
    return await requirePermission("discounts.apply");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

/** Owners / Super Admin: mark a client as paying outside Stripe (or back to paying through Stripe). */
export async function setPaysOutsideStripe(clientId: string, on: boolean, method: string | null): Promise<ActionResult> {
  const actor = await staff();
  if (!actor) return { ok: false, error: "Only Owners and the Super Admin can change how a client pays." };
  const c = await db.client.findUnique({ where: { id: clientId } });
  if (!c) return { ok: false, error: "Client not found." };
  const m = on ? (method?.trim() || null) : null;
  if (on && !m) return { ok: false, error: "Choose how this client pays." };
  await db.client.update({ where: { id: clientId }, data: { paysOutsideStripe: on, outsidePaymentMethod: m } });
  await writeAudit({ actorId: actor.id, action: "client_pays_outside_stripe", entity: "Client", entityId: clientId, before: { paysOutsideStripe: c.paysOutsideStripe, method: c.outsidePaymentMethod }, after: { paysOutsideStripe: on, method: m } });
  return { ok: true };
}

export type OutsideBill = {
  clientId: string;
  clientName: string;
  clientHref: string;
  method: string | null;
  /** The portal's invoice row, once Stripe has issued the bill. */
  invoiceId: string | null;
  stripeInvoiceNumber: string | null;
  amountCents: number;
  dueOn: Date;
  daysUntil: number;
  state: "upcoming" | "due" | "overdue";
};

/**
 * What outside-Stripe clients owe: their open bills (from Stripe's emailed invoices) and, where the next bill isn't
 * issued yet, the next one predicted from the subscription (billing date + days until due).
 */
export async function outsideBills(now: Date = new Date(), stripe?: Stripe): Promise<OutsideBill[]> {
  const clients = await db.client.findMany({ where: { paysOutsideStripe: true, OR: [{ endedAt: null }, { endedAt: { gt: now } }] }, orderBy: { name: "asc" } });
  if (!clients.length) return [];
  const out: OutsideBill[] = [];
  for (const c of clients) {
    const href = `/clients/${c.stripeSubscriptionId ?? c.id}`;
    const open = await db.invoice.findMany({ where: { clientId: c.id, kind: "SUBSCRIPTION", status: "open" }, orderBy: { billedAt: "asc" } });
    for (const inv of open) {
      const due = inv.dueAt ?? inv.billedAt;
      const d = daysUntil(due, now);
      out.push({ clientId: c.id, clientName: c.name, clientHref: href, method: c.outsidePaymentMethod, invoiceId: inv.id, stripeInvoiceNumber: inv.stripeInvoiceId, amountCents: inv.totalCents - inv.amountPaidCents, dueOn: due, daysUntil: d, state: d < 0 ? "overdue" : d === 0 ? "due" : "upcoming" });
    }
    // The next bill, before Stripe issues it, so the 7-day reminder can go out in time.
    const next = await nextBill(c, stripe);
    if (next && !open.some((i) => i.periodStart.getTime() >= next.billingOn.getTime() - DAY)) {
      const d = daysUntil(next.dueOn, now);
      if (d >= 0) out.push({ clientId: c.id, clientName: c.name, clientHref: href, method: c.outsidePaymentMethod, invoiceId: null, stripeInvoiceNumber: null, amountCents: next.amountCents, dueOn: next.dueOn, daysUntil: d, state: d === 0 ? "due" : "upcoming" });
    }
  }
  return out.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
}

async function nextBill(c: Client, client?: Stripe): Promise<{ billingOn: Date; dueOn: Date; amountCents: number } | null> {
  if (!c.stripeSubscriptionId) return null;
  try {
    const stripe = client ?? getStripe();
    const sub = await stripe.subscriptions.retrieve(c.stripeSubscriptionId);
    if (sub.status === "canceled" || sub.status === "incomplete_expired" || sub.pause_collection) return null;
    const end = sub.items.data.reduce((m, it) => Math.min(m, (it as { current_period_end?: number }).current_period_end ?? Infinity), Infinity);
    if (!Number.isFinite(end)) return null;
    const billingOn = new Date(end * 1000);
    const dueOn = new Date(billingOn.getTime() + (sub.days_until_due ?? 0) * DAY);
    const amountCents = sub.items.data.reduce((n, it) => n + (it.price.unit_amount ?? 0) * (it.quantity ?? 1), 0);
    return { billingOn, dueOn, amountCents };
  } catch (e) {
    console.error(`[outside-payments] ${c.id}:`, (e as Error).message);
    return null;
  }
}

/** Daily: remind the Super Admin(s) 7 days before, 1 day before and on the due date of each outside-Stripe bill. */
export async function runOutsidePaymentReminders(now: Date = new Date(), stripe?: Stripe): Promise<number> {
  const bills = (await outsideBills(now, stripe)).filter((b) => b.daysUntil >= 0 && b.daysUntil <= 7);
  if (!bills.length) return 0;
  const admins = await db.user.findMany({ where: { role: "SUPER_ADMIN" } });
  let sent = 0;
  for (const b of bills) {
    // The latest reminder that's due (a bill noticed late gets one reminder, not a burst).
    const step = [...OUTSIDE_REMINDER_DAYS].reverse().find((s) => b.daysUntil <= s)!;
    const t = templates.outsidePaymentDue({
      clientName: b.clientName,
      amount: formatUsd(b.amountCents),
      dueOn: fmtDay(b.dueOn),
      daysUntil: b.daysUntil,
      method: b.method,
      url: `${baseUrl()}/payments/outside`,
    });
    for (const a of admins) {
      const r = await sendNotice({ key: `outside-due:${b.clientId}:${ymd(b.dueOn)}:${step}:${a.id}`, kind: `outside_due_${step}`, clientId: b.clientId, to: { name: a.name, email: a.email }, email: { subject: t.subject, html: t.html } });
      if (r === "SENT") sent++;
    }
  }
  return sent;
}

/**
 * Owners / Super Admin: record a payment made outside Stripe. Marks the Stripe invoice "paid out of band" (no
 * charge is made), records date, method and reference, and lets the payment count for reports and commission.
 */
export async function markPaidOutside(invoiceId: string, i: { paidOn: string; method: string; reference: string }, stripe?: Stripe): Promise<ActionResult> {
  const actor = await staff();
  if (!actor) return { ok: false, error: "Only Owners and the Super Admin can record payments." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.paidOn)) return { ok: false, error: "Enter the date it was paid." };
  const method = i.method.trim();
  if (!method) return { ok: false, error: "Choose how it was paid." };
  const inv = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv?.clientId) return { ok: false, error: "Bill not found. Refresh and try again." };
  if (inv.status === "paid") return { ok: false, error: "This bill is already marked paid." };
  if (inv.status !== "open") return { ok: false, error: `This bill is ${inv.status} in Stripe, so it can't be marked paid.` };
  const paidAt = startOfDayIn(i.paidOn, TZ());
  if (paidAt.getTime() > Date.now() + DAY) return { ok: false, error: "The paid date can't be in the future." };

  await (stripe ?? getStripe()).invoices.pay(inv.stripeInvoiceId, { paid_out_of_band: true }, { idempotencyKey: `bc-paid-outside-${inv.stripeInvoiceId}` });
  await db.invoice.update({
    where: { id: inv.id },
    data: {
      status: "paid",
      paidAt,
      amountPaidCents: inv.totalCents,
      paymentMethodType: "outside",
      processingSince: null,
      paidOutsideAt: paidAt,
      outsideMethod: method,
      outsideReference: i.reference.trim() || null,
      outsideMarkedById: actor.id,
    },
  });
  await writeAudit({ actorId: actor.id, action: "invoice_paid_outside_stripe", entity: "Invoice", entityId: inv.id, after: { stripeInvoiceId: inv.stripeInvoiceId, paidOn: i.paidOn, method, reference: i.reference.trim() || null, amountCents: inv.totalCents } });
  await recordPaymentCommission(inv.id);
  await refreshClientStatus(inv.clientId);
  return { ok: true };
}
