import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { matchPackage } from "@/domain/packageMatch";
import { can } from "@/auth/permissions";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import type { ClientStatus } from "@/domain/clientStatus";
import { discountState } from "@/domain/pricing";
import { ensureClientSubscription } from "@/clients/subscriptions";

type Base = Pick<LiveClientRow, "subscriptionId" | "name" | "status" | "packageName" | "sixMonthContract" | "nextChargeDate" | "pastDueSince"> & { clientType: "DIRECT" | "ACE" };
type Financial = Pick<
  LiveClientRow,
  "customerId" | "email" | "packageMonthlyCents" | "cardFeeMonthlyCents" | "hasDiscount" | "autopay" | "paymentMethod" | "amountDueCents" | "listPriceCents" | "discounted"
>;
export type ClientRow = Base & Partial<Financial>;

/** Field-level scoping at the data layer: roles without clients.viewFinancials never receive money or contact fields. */
export function scopeRow(r: LiveClientRow, role: Role): ClientRow {
  const base: Base = {
    subscriptionId: r.subscriptionId,
    name: r.name,
    status: r.status,
    packageName: r.packageName,
    sixMonthContract: r.sixMonthContract,
    nextChargeDate: r.nextChargeDate,
    pastDueSince: r.pastDueSince,
    clientType: r.clientType ?? "DIRECT",
  };
  if (!can(role, "clients.viewFinancials")) return base;
  return {
    ...base,
    customerId: r.customerId,
    email: r.email,
    packageMonthlyCents: r.packageMonthlyCents,
    cardFeeMonthlyCents: r.cardFeeMonthlyCents,
    hasDiscount: r.hasDiscount,
    autopay: r.autopay,
    paymentMethod: r.paymentMethod,
    amountDueCents: r.amountDueCents,
    listPriceCents: r.listPriceCents ?? null,
    discounted: r.discounted ?? false,
  };
}

const URGENCY: ClientStatus[] = ["SUSPENDED", "AT_RISK", "PAST_DUE", "UNPAID", "ACE_AWAITING_DECISION", "CURRENT", "CONTINUING_AWAITING_PM", "PREPAID_ACE", "ONBOARDING", "PAUSED", "ENDED"];

/**
 * Read-only bridge until the Plan 6 import: make sure every live Stripe customer has a portal Client row (create-only),
 * so webhooks and discounts can find it. Only Stripe-owned fields are written; Direct/ACE etc. are left alone.
 */
export async function syncClientsFromSnapshot(rows: LiveClientRow[]): Promise<void> {
  const packages = await db.package.findMany({ select: { id: true, name: true, stripePriceId: true } });
  const packageOf = (r: LiveClientRow) => (r.priceItems?.length ? matchPackage(r.priceItems, packages) : null);
  const byCustomer = new Map<string, LiveClientRow>();
  for (const r of rows) {
    const cur = byCustomer.get(r.customerId);
    if (!cur || URGENCY.indexOf(r.status) < URGENCY.indexOf(cur.status)) byCustomer.set(r.customerId, r);
  }
  for (const r of byCustomer.values()) {
    // Create missing clients only. Status, subscription link and Stripe status belong to the webhooks;
    // only contact details are refreshed here.
    const existing = await db.client.findUnique({ where: { stripeCustomerId: r.customerId } });
    if (!existing) {
      await db.client.create({
        data: {
          stripeCustomerId: r.customerId,
          stripeSubscriptionId: r.subscriptionId,
          name: r.name,
          email: r.email,
          phone: r.phone ?? null,
          status: r.status,
          subscriptionStatus: r.status === "PAUSED" ? "paused" : null,
          packageId: packageOf(r),
        },
      });
      continue;
    }
    const phone = r.phone ?? existing.phone;
    const contactChanged = r.email !== existing.email || phone !== existing.phone;
    await db.client.update({
      where: { id: existing.id },
      // A changed email/phone means the cached GHL contact may be the wrong person: look it up again next time.
      data: {
        name: r.name,
        email: r.email,
        phone,
        ...(contactChanged ? { ghlContactId: null } : {}),
        // Link the package from Stripe only when none is set; a package chosen by hand is never overwritten.
        ...(existing.packageId ? {} : { packageId: packageOf(r) }),
      },
    });
  }
  // Every subscription (a client can pay for several packages, each billed on its own day).
  const clientIds = new Map(
    (await db.client.findMany({ where: { stripeCustomerId: { in: [...byCustomer.keys()] } }, select: { id: true, stripeCustomerId: true } })).map((c) => [c.stripeCustomerId!, c.id]),
  );
  for (const r of rows) {
    const clientId = clientIds.get(r.customerId);
    const products = [...new Set((r.priceItems ?? []).map((i) => i.productName).filter((n) => !/credit card fee|onboarding/i.test(n)))].join(" + ");
    if (clientId) await ensureClientSubscription(clientId, r.subscriptionId, packageOf(r), products || r.packageName.replace(/^Other: /, ""));
  }
}

/** Adds Direct/ACE from the portal's client records to live Stripe rows. */
export async function withClientTypes(rows: LiveClientRow[]): Promise<LiveClientRow[]> {
  const ids = rows.map((r) => r.subscriptionId);
  const aces = await db.client.findMany({
    where: { type: "ACE", OR: [{ stripeSubscriptionId: { in: ids } }, { subscriptions: { some: { stripeSubscriptionId: { in: ids } } } }] },
    select: { stripeSubscriptionId: true, acePrepaidUntil: true, subscriptions: { select: { stripeSubscriptionId: true } } },
  });
  const ace = new Map<string, { acePrepaidUntil: Date | null }>();
  for (const a of aces) for (const s of [a.stripeSubscriptionId, ...a.subscriptions.map((x) => x.stripeSubscriptionId)]) if (s) ace.set(s, a);
  const now = new Date();
  return rows.map((r) => {
    const a = ace.get(r.subscriptionId);
    if (!a) return { ...r, clientType: "DIRECT" as const };
    // A continued ACE client is still prepaid until the period ends, whatever Stripe shows meanwhile.
    const prepaid = a.acePrepaidUntil !== null && a.acePrepaidUntil > now;
    return { ...r, clientType: "ACE" as const, ...(prepaid ? { status: "PREPAID_ACE" as const, pastDueSince: null, amountDueCents: 0 } : {}) };
  });
}

/**
 * Adds the portal side of pricing to live rows: the linked package's name and list price, and whether the client
 * pays less than that list price (a Stripe discount, or a lower custom price such as one set by hand in Stripe).
 */
export async function withPricing(rows: LiveClientRow[]): Promise<LiveClientRow[]> {
  const ids = rows.map((r) => r.subscriptionId);
  // A subscription's own package if set; for a client's main subscription, the client's package.
  const subRows = await db.clientSubscription.findMany({ where: { stripeSubscriptionId: { in: ids } }, select: { stripeSubscriptionId: true, packageId: true } });
  const mains = await db.client.findMany({ where: { stripeSubscriptionId: { in: ids } }, select: { stripeSubscriptionId: true, packageId: true } });
  const pkgIdOf = new Map<string, string | null>();
  for (const m of mains) pkgIdOf.set(m.stripeSubscriptionId!, m.packageId);
  for (const s of subRows) if (s.packageId || !pkgIdOf.has(s.stripeSubscriptionId)) pkgIdOf.set(s.stripeSubscriptionId, s.packageId);
  const pkgs = await db.package.findMany({ where: { id: { in: [...pkgIdOf.values()].filter((x): x is string => !!x) } }, select: { id: true, name: true, monthlyPriceCents: true, isCustom: true } });
  const pkgById = new Map(pkgs.map((p) => [p.id, p]));
  return rows.map((r) => {
    const id = pkgIdOf.get(r.subscriptionId);
    const p = id ? pkgById.get(id) ?? null : null;
    const listPriceCents = p && !p.isCustom ? p.monthlyPriceCents : null;
    const packageName = p && (r.packageName === "—" || r.packageName.startsWith("Other:")) ? p.name : r.packageName;
    return { ...r, packageName, listPriceCents, discounted: discountState(r, listPriceCents).discounted };
  });
}

/**
 * ACE clients who aren't on a Stripe subscription yet (prepaid, or waiting to continue), as dashboard rows.
 * Their row id is the portal client id, which the client page also accepts.
 */
export async function aceDashboardRows(): Promise<LiveClientRow[]> {
  // Statuses change with the calendar (prepaid period ending), so bring them up to date before showing them.
  const pending = await db.client.findMany({ where: { type: "ACE", stripeSubscriptionId: null, status: { not: "ENDED" } }, select: { id: true } });
  for (const c of pending) await refreshClientStatus(c.id);
  const clients = await db.client.findMany({
    where: { type: "ACE", stripeSubscriptionId: null, status: { not: "ENDED" } },
    orderBy: { name: "asc" },
  });
  const packages = await db.package.findMany({ where: { id: { in: clients.flatMap((c) => (c.packageId ? [c.packageId] : [])) } } });
  const name = new Map(packages.map((p) => [p.id, p.name]));
  return clients.map((c) => ({
    clientType: "ACE" as const,
    customerId: c.stripeCustomerId ?? "",
    subscriptionId: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    packageName: c.packageId ? name.get(c.packageId) ?? "—" : "—",
    sixMonthContract: false,
    packageMonthlyCents: 0,
    cardFeeMonthlyCents: 0,
    hasDiscount: false,
    autopay: false,
    paymentMethod: "Prepaid by ACE",
    nextChargeDate: null,
    amountDueCents: 0,
    pastDueSince: null,
  }));
}
