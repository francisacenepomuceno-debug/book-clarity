import type Stripe from "stripe";
import type { Client } from "@prisma/client";
import { db } from "@/lib/db";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { updatePaymentLink } from "@/notify/paymentLink";
import { formatUsd } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { idOf, subscriptionIdOf } from "@/stripe/lines";

const DAY = 86400_000;
export const FOLLOW_UP_DAYS = [3, 7, 14] as const;
export const AT_RISK_DAYS = 21;
export const baseUrl = () => process.env.PORTAL_BASE_URL ?? "http://localhost:3000";

/** Payment reminders never go to ended clients or to ACE clients inside their prepaid period. */
export function remindable(c: Pick<Client, "endedAt" | "acePrepaidUntil">, now: Date): boolean {
  if (c.endedAt && c.endedAt <= now) return false;
  if (c.acePrepaidUntil && c.acePrepaidUntil > now) return false;
  return true;
}

const recipient = (c: Client) => ({ name: c.name, email: c.email, phone: c.phone, ghlContactId: c.ghlContactId });

/** Stripe invoice.upcoming (about 3 days before a renewal): "your payment is coming up". */
export async function onUpcomingInvoice(inv: Stripe.Invoice, now: Date = new Date()): Promise<void> {
  if (inv.collection_method === "send_invoice") return;
  const client = await db.client.findUnique({ where: { stripeCustomerId: idOf(inv.customer as string) ?? "" } });
  if (!client || !remindable(client, now) || client.subscriptionStatus === "paused") return;
  const sub = subscriptionIdOf(inv) ?? "none";
  const when = new Date(((inv.next_payment_attempt ?? inv.period_end) as number) * 1000);
  const t = templates.upcomingCharge({
    name: client.name,
    amount: formatUsd(inv.amount_due ?? 0),
    date: fmtDate(when),
    updateUrl: updatePaymentLink(client.id, baseUrl()),
  });
  await sendNotice({ key: `upcoming:${sub}:${inv.period_end}`, kind: "upcoming_charge", clientId: client.id, to: recipient(client), email: { subject: t.subject, html: t.html }, sms: t.sms });
}

async function sendFailed(invoiceRowId: string, day: 0 | 3 | 7 | 14, now: Date): Promise<void> {
  const inv = await db.invoice.findUnique({ where: { id: invoiceRowId } });
  if (!inv?.clientId || inv.status !== "open") return;
  const client = await db.client.findUniqueOrThrow({ where: { id: inv.clientId } });
  if (!remindable(client, now)) return;
  const t = templates.paymentFailed({
    name: client.name,
    amount: formatUsd(inv.totalCents - inv.amountPaidCents),
    day,
    updateUrl: updatePaymentLink(client.id, baseUrl()),
  });
  await sendNotice({ key: `failed:${inv.id}:${day}`, kind: `payment_failed_${day}`, clientId: client.id, to: recipient(client), email: { subject: t.subject, html: t.html }, sms: t.sms });
}

/** Webhook invoice.payment_failed: the day-0 notice. */
export async function onPaymentFailedNotice(invoiceRowId: string, now: Date = new Date()): Promise<void> {
  await sendFailed(invoiceRowId, 0, now);
}

/** Daily: the follow-up that's due (3, 7 or 14 days after the first failure), and the day-21 Owner alert. */
export async function runPaymentReminders(now: Date = new Date()): Promise<{ followUps: number; ownerAlerts: number }> {
  const open = await db.invoice.findMany({ where: { status: "open", kind: "SUBSCRIPTION", firstFailedAt: { not: null }, clientId: { not: null } } });
  let followUps = 0;
  let ownerAlerts = 0;
  for (const inv of open) {
    const days = Math.floor((now.getTime() - inv.firstFailedAt!.getTime()) / DAY);
    // Only the latest step that's due, so a missed day never sends a burst of old reminders.
    const step = [...FOLLOW_UP_DAYS].reverse().find((d) => days >= d);
    if (step) {
      await sendFailed(inv.id, step, now);
      followUps++;
    }
    if (days >= AT_RISK_DAYS) {
      const client = await db.client.findUniqueOrThrow({ where: { id: inv.clientId! } });
      if (!remindable(client, now)) continue;
      const owners = await db.user.findMany({ where: { role: { in: ["OWNER", "SUPER_ADMIN"] } } });
      const t = templates.ownerAtRisk({
        clientName: client.name,
        amount: formatUsd(inv.totalCents - inv.amountPaidCents),
        since: fmtDate(inv.firstFailedAt),
        clientUrl: `${baseUrl()}/clients/${client.stripeSubscriptionId ?? client.id}`,
      });
      for (const o of owners) {
        await sendNotice({ key: `at-risk:${inv.id}:${o.id}`, kind: "owner_at_risk", to: { name: o.name, email: o.email }, email: { subject: t.subject, html: t.html } });
        ownerAlerts++;
      }
    }
  }
  return { followUps, ownerAlerts };
}
