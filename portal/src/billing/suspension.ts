import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/stripe/client";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { getOnboardingSettings } from "@/settings/onboarding";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import { updatePaymentLink } from "@/notify/paymentLink";
import { formatUsd } from "@/lib/money";
import type { ActionResult } from "@/billing/discounts";

const DAY_MS = 86400_000;
const SUSPENDED_META = "bc_suspended";

/**
 * Daily: suspend clients whose monthly invoice is still unpaid N days (setting, default 30) after it first failed.
 * Pauses Stripe collection (invoices during the pause are voided; no late fees) and tells the client and staff.
 */
export async function runSuspensions(now: Date = new Date(), stripe: Stripe = getStripe()): Promise<number> {
  const { suspendAfterDays } = await getOnboardingSettings();
  const due = await db.invoice.findMany({
    where: {
      kind: "SUBSCRIPTION",
      status: "open",
      processingSince: null,
      firstFailedAt: { lte: new Date(now.getTime() - suspendAfterDays * DAY_MS) },
      client: {
        suspendedAt: null,
        endedAt: null,
        stripeSubscriptionId: { not: null },
        OR: [{ acePrepaidUntil: null }, { acePrepaidUntil: { lte: now } }],
      },
    },
    include: { client: true },
    orderBy: { firstFailedAt: "asc" },
  });
  const staff = due.length ? await db.user.findMany({ where: { role: { in: ["OWNER", "ADMIN"] } } }) : [];
  let suspended = 0;
  const seen = new Set<string>();
  for (const inv of due) {
    const c = inv.client!;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    await stripe.subscriptions.update(
      c.stripeSubscriptionId!,
      { pause_collection: { behavior: "void" }, metadata: { [SUSPENDED_META]: "1" } },
      { idempotencyKey: `bc-suspend-${inv.stripeInvoiceId}` },
    );
    const claimed = await db.client.updateMany({ where: { id: c.id, suspendedAt: null }, data: { suspendedAt: now } });
    if (claimed.count !== 1) continue;
    suspended++;
    await writeAudit({ actorId: null, action: "client_suspended", entity: "Client", entityId: c.id, after: { invoiceId: inv.stripeInvoiceId, days: suspendAfterDays } });
    await refreshClientStatus(c.id, now);

    const amount = formatUsd(inv.totalCents - inv.amountPaidCents);
    const t = templates.serviceSuspended({ name: c.name, amount, updateUrl: updatePaymentLink(c.id, baseUrl()) });
    await sendNotice({ key: `suspended:${inv.id}`, kind: "suspended", clientId: c.id, to: { name: c.name, email: c.email, phone: c.phone, ghlContactId: c.ghlContactId }, email: t, sms: t.sms });
    const st = templates.staffClientSuspended({ clientName: c.name, amount, days: suspendAfterDays, clientUrl: `${baseUrl()}/clients/${c.stripeSubscriptionId}` });
    for (const u of staff) {
      await sendNotice({ key: `suspended-staff:${inv.id}:${u.id}`, kind: "suspended_staff", to: { name: u.name, email: u.email }, email: st });
    }
  }
  return suspended;
}

async function resume(clientId: string, actorId: string | null, reason: string, stripe: Stripe): Promise<boolean> {
  const c = await db.client.findUnique({ where: { id: clientId } });
  if (!c?.suspendedAt) return false;
  if (c.stripeSubscriptionId) {
    await stripe.subscriptions.update(c.stripeSubscriptionId, { pause_collection: "", metadata: { [SUSPENDED_META]: "" } });
  }
  const done = await db.client.updateMany({ where: { id: clientId, suspendedAt: { not: null } }, data: { suspendedAt: null } });
  if (done.count !== 1) return false;
  await writeAudit({ actorId, action: "client_resumed", entity: "Client", entityId: clientId, after: { reason } });
  await refreshClientStatus(clientId);
  return true;
}

/** Webhook (a monthly invoice was paid): resumes a suspended client once nothing failed is still unpaid. */
export async function resumeIfPaidUp(clientId: string, stripe: Stripe = getStripe()): Promise<boolean> {
  const c = await db.client.findUnique({ where: { id: clientId }, select: { suspendedAt: true } });
  if (!c?.suspendedAt) return false;
  const stillOwed = await db.invoice.count({ where: { clientId, kind: "SUBSCRIPTION", status: "open", firstFailedAt: { not: null } } });
  if (stillOwed > 0) return false;
  return resume(clientId, null, "paid", stripe);
}

/** Owners: resume a suspended client by hand (e.g. a payment arrangement). */
export async function resumeClient(clientId: string, stripe: Stripe = getStripe()): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "Only Owners can resume a suspended client." };
    throw e;
  }
  return (await resume(clientId, actor.id, "manual", stripe)) ? { ok: true } : { ok: false, error: "This client isn't suspended." };
}
