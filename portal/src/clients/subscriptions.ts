import type { Client, ClientSubscription, Package } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A client can pay for several packages, each its own Stripe subscription on its own billing day
 * (e.g. bookkeeping on the 1st and a Custom AR/AP package on the 15th).
 * Client.stripeSubscriptionId is the client's main subscription; every subscription also has a ClientSubscription row.
 */
export type SubscriptionRef = { client: Client; subscriptionId: string; packageId: string | null; package: Package | null; isMain: boolean; row: ClientSubscription | null };

/** Records a subscription of a client (idempotent). Never overwrites a package chosen by hand. */
export async function ensureClientSubscription(clientId: string, subscriptionId: string, packageId: string | null = null, productName?: string | null): Promise<ClientSubscription> {
  const existing = await db.clientSubscription.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
  if (existing) {
    const data = {
      ...(!existing.packageId && packageId ? { packageId } : {}),
      ...(productName && productName !== existing.productName ? { productName } : {}),
    };
    return Object.keys(data).length ? db.clientSubscription.update({ where: { id: existing.id }, data }) : existing;
  }
  // A client's main subscription starts with the client's package when Stripe doesn't say.
  const client = packageId ? null : await db.client.findUnique({ where: { id: clientId }, select: { stripeSubscriptionId: true, packageId: true } });
  const pkg = packageId ?? (client?.stripeSubscriptionId === subscriptionId ? client.packageId : null);
  return db.clientSubscription.upsert({
    where: { stripeSubscriptionId: subscriptionId },
    create: { clientId, stripeSubscriptionId: subscriptionId, packageId: pkg, productName: productName ?? null },
    update: {},
  });
}

/** The client and package behind a Stripe subscription, or null if the portal doesn't know it. */
export async function subscriptionRef(subscriptionId: string): Promise<SubscriptionRef | null> {
  const row = await db.clientSubscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, include: { client: true, package: true } });
  if (row) {
    const isMain = row.client.stripeSubscriptionId === subscriptionId;
    // The main subscription's package is also the client's package; fall back to it for older rows.
    const packageId = row.packageId ?? (isMain ? row.client.packageId : null);
    const pkg = row.package ?? (packageId ? await db.package.findUnique({ where: { id: packageId } }) : null);
    const { client, package: _p, ...plain } = row;
    void _p;
    return { client, subscriptionId, packageId, package: pkg, isMain, row: plain as ClientSubscription };
  }
  const client = await db.client.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
  if (!client) return null;
  const pkg = client.packageId ? await db.package.findUnique({ where: { id: client.packageId } }) : null;
  return { client, subscriptionId, packageId: client.packageId, package: pkg, isMain: true, row: null };
}

/** Every subscription the portal knows for a client (main first), including the main one if it has no row yet. */
export async function subscriptionsOf(client: Client): Promise<{ subscriptionId: string; packageId: string | null; productName: string | null; monthsBeforePortal: number; endedAt: Date | null; isMain: boolean }[]> {
  const rows = await db.clientSubscription.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "asc" } });
  const out = rows.map((r) => ({
    subscriptionId: r.stripeSubscriptionId,
    packageId: r.packageId ?? (r.stripeSubscriptionId === client.stripeSubscriptionId ? client.packageId : null),
    productName: r.productName,
    monthsBeforePortal: r.commissionMonthsBeforePortal,
    endedAt: r.endedAt,
    isMain: r.stripeSubscriptionId === client.stripeSubscriptionId,
  }));
  if (client.stripeSubscriptionId && !out.some((s) => s.isMain)) {
    out.push({ subscriptionId: client.stripeSubscriptionId, packageId: client.packageId, productName: null, monthsBeforePortal: 0, endedAt: client.endedAt, isMain: true });
  }
  return out.sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/** Live (not ended) subscriptions on a package, with their clients: the main one per client plus any extra ones. */
export async function activeSubscriptionsOnPackage(packageId: string): Promise<{ client: Client; subscriptionId: string }[]> {
  const rows = await db.clientSubscription.findMany({ where: { packageId, endedAt: null, client: { endedAt: null } }, include: { client: true } });
  const seen = new Set(rows.map((r) => r.stripeSubscriptionId));
  // Main subscriptions without a row yet (older data), linked through the client's package.
  const mains = await db.client.findMany({ where: { packageId, endedAt: null, stripeSubscriptionId: { not: null } } });
  const mainRows = await db.clientSubscription.findMany({ where: { stripeSubscriptionId: { in: mains.map((m) => m.stripeSubscriptionId!) } } });
  const rowOf = new Map(mainRows.map((r) => [r.stripeSubscriptionId, r]));
  return [
    ...rows.map((r) => ({ client: r.client, subscriptionId: r.stripeSubscriptionId })),
    ...mains
      .filter((m) => {
        const r = rowOf.get(m.stripeSubscriptionId!);
        // No row yet, or a row without its own package (the client's package applies), and not ended.
        return !seen.has(m.stripeSubscriptionId!) && (!r || (r.packageId === null && r.endedAt === null));
      })
      .map((m) => ({ client: m, subscriptionId: m.stripeSubscriptionId! })),
  ];
}
