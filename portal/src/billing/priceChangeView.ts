import { db } from "@/lib/db";
import { currentPriceChange } from "@/billing/priceChanges";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import { activeSubscriptionsOnPackage } from "@/clients/subscriptions";

type NotChanged = { name: string; monthlyCents: number; why: string };

export type PriceChangeView = {
  id: string;
  oldMonthlyCents: number;
  newMonthlyCents: number;
  effectiveAt: Date;
  packageSwitched: boolean;
  canCancel: boolean;
  moved: { name: string; startsOn: Date }[];
  noticed: number;
};

/**
 * For the Packages page: a package's price change in progress (if any), and from the live Stripe data who it moves
 * (current clients on the full list price) and who it leaves as they are (discount, custom or 6-month price).
 * `rows` is the live snapshot, or null when Stripe couldn't be loaded.
 */
export async function priceChangeView(
  packageId: string,
  listPriceCents: number,
  rows: LiveClientRow[] | null,
  now: Date = new Date(),
): Promise<{ change: PriceChangeView | null; preview: { willMove: string[]; notChanged: NotChanged[] } | null }> {
  // Every running subscription on the package (a client's main one and any extra ones).
  const clients = (await activeSubscriptionsOnPackage(packageId))
    .map((s) => ({ id: s.client.id, name: s.client.name, stripeSubscriptionId: s.subscriptionId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const c = await currentPriceChange(packageId, now);
  const moved = new Set(c?.moves.map((m) => m.subscriptionId) ?? []);
  let preview: { willMove: string[]; notChanged: NotChanged[] } | null = null;
  if (rows) {
    const bySub = new Map(rows.map((r) => [r.subscriptionId, r]));
    const price = c ? c.oldMonthlyCents : listPriceCents;
    const willMove: string[] = [];
    const notChanged: NotChanged[] = [];
    for (const cl of clients) {
      if (moved.has(cl.stripeSubscriptionId)) continue;
      const r = bySub.get(cl.stripeSubscriptionId!);
      if (!r) continue;
      if (r.hasDiscount) notChanged.push({ name: cl.name, monthlyCents: r.packageMonthlyCents, why: "has a discount" });
      else if (r.sixMonthContract) notChanged.push({ name: cl.name, monthlyCents: r.packageMonthlyCents, why: "6-month contract price" });
      else if (r.packageMonthlyCents !== price) notChanged.push({ name: cl.name, monthlyCents: r.packageMonthlyCents, why: "custom price" });
      else willMove.push(cl.name);
    }
    preview = { willMove, notChanged };
  }
  if (!c) return { change: null, preview };
  const names = new Map(clients.map((x) => [x.id, x.name]));
  const noticed = await db.notification.count({ where: { key: { startsWith: `price-increase:${c.id}:` }, status: "SENT" } });
  return {
    change: {
      id: c.id,
      oldMonthlyCents: c.oldMonthlyCents,
      newMonthlyCents: c.newMonthlyCents,
      effectiveAt: c.effectiveAt,
      packageSwitched: !!c.packageSwitchedAt,
      canCancel: !c.packageSwitchedAt && c.moves.length === 0,
      moved: c.moves.map((m) => ({ name: names.get(m.clientId) ?? m.clientId, startsOn: m.startsOn })),
      noticed,
    },
    preview,
  };
}
