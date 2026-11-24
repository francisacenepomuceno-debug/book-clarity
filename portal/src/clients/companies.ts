import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import type { ActionResult } from "@/billing/discounts";

/**
 * Owners / Super Admin: one Stripe customer can pay for several companies (e.g. Barjona Andrews' two companies, or
 * Ivan Shammas' Hispanic Plug and Mundo Media). This makes one of the customer's subscriptions its own client
 * (company): its own name, main package, status and commission window (and the same commission split to start with).
 * Its invoices and commission lines move with it. Stripe is not changed.
 */
export async function separateCompany(subscriptionId: string, companyName: string): Promise<ActionResult<{ clientId: string }>> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "Only Owners and the Super Admin can separate companies." };
    throw e;
  }
  const name = companyName.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Enter the company's name." };
  const row = await db.clientSubscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, include: { client: true } });
  if (!row) return { ok: false, error: "Subscription not found. Refresh and try again." };
  const from = row.client;
  const others = await db.clientSubscription.findMany({ where: { clientId: from.id, stripeSubscriptionId: { not: subscriptionId }, endedAt: null } });
  if (others.length === 0) return { ok: false, error: "This is the client's only package. Rename the client instead of separating it." };

  const wasMain = from.stripeSubscriptionId === subscriptionId;
  const created = await db.$transaction(async (tx) => {
    // If the moved subscription was the old client's main one, another of theirs becomes main first (a subscription
    // can be the main one of only one client). The main package's months already earned are kept on the client, so
    // they go with the moved package, and the new main package's own months become the old client's.
    if (wasMain) {
      const next = others[0];
      await tx.client.update({
        where: { id: from.id },
        data: {
          stripeSubscriptionId: next.stripeSubscriptionId,
          subscriptionStatus: next.status,
          commissionMonthsBeforePortal: next.commissionMonthsBeforePortal,
          ...(next.packageId ? { packageId: next.packageId } : {}),
        },
      });
      await tx.clientSubscription.update({ where: { id: next.id }, data: { commissionMonthsBeforePortal: 0 } });
    }
    const c = await tx.client.create({
      data: {
        name,
        email: from.email,
        phone: from.phone,
        billingState: from.billingState,
        type: "DIRECT",
        status: from.status,
        stripeCustomerId: from.stripeCustomerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: row.status,
        packageId: row.packageId ?? (wasMain ? from.packageId : null),
        defaultPaymentFunding: from.defaultPaymentFunding,
        paysOutsideStripe: from.paysOutsideStripe,
        outsidePaymentMethod: from.outsidePaymentMethod,
        // This package's months already earned become the new company's main-package months.
        commissionMonthsBeforePortal: wasMain ? from.commissionMonthsBeforePortal : row.commissionMonthsBeforePortal,
      },
    });
    await tx.clientSubscription.update({ where: { id: row.id }, data: { clientId: c.id, commissionMonthsBeforePortal: 0 } });
    const invoices = await tx.invoice.findMany({ where: { clientId: from.id, stripeSubscriptionId: subscriptionId }, select: { id: true } });
    const ids = invoices.map((i) => i.id);
    if (ids.length) {
      await tx.invoice.updateMany({ where: { id: { in: ids } }, data: { clientId: c.id } });
      await tx.commissionEntry.updateMany({ where: { invoiceId: { in: ids } }, data: { clientId: c.id } });
    }
    // Same commission owners to start with; Owners can change them on the new company's page.
    const shares = await tx.commissionShare.findMany({ where: { clientId: from.id } });
    for (const s of shares) {
      await tx.commissionShare.create({ data: { clientId: c.id, executiveId: s.executiveId, rateBp: s.rateBp, effectiveFrom: s.effectiveFrom, createdById: actor.id } });
    }
    return { client: c, invoices: ids.length };
  });
  await writeAudit({ actorId: actor.id, action: "company_separated", entity: "Client", entityId: created.client.id, after: { name, subscriptionId, fromClientId: from.id, invoicesMoved: created.invoices } });
  await refreshClientStatus(created.client.id);
  await refreshClientStatus(from.id);
  return { ok: true, clientId: created.client.id };
}

/** Owners / Super Admin: rename a client (company). Kept even when Stripe's customer name differs. */
export async function renameClient(clientId: string, name: string): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "Only Owners and the Super Admin can rename clients." };
    throw e;
  }
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return { ok: false, error: "Enter a name." };
  const c = await db.client.findUnique({ where: { id: clientId } });
  if (!c) return { ok: false, error: "Client not found." };
  if (c.name === n) return { ok: true };
  await db.client.update({ where: { id: clientId }, data: { name: n } });
  await writeAudit({ actorId: actor.id, action: "client_renamed", entity: "Client", entityId: clientId, before: { name: c.name }, after: { name: n } });
  return { ok: true };
}
