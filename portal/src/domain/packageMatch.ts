import { classifyProduct } from "@/stripe/catalog";

export type PriceItem = { priceId: string; productName: string };
type PackageRef = { id: string; name: string; stripePriceId: string | null };

/** Pure: the portal package a Stripe subscription is on — by price ID first, then by product name. */
export function matchPackage(items: PriceItem[], packages: PackageRef[]): string | null {
  const byPrice = new Map(packages.filter((p) => p.stripePriceId).map((p) => [p.stripePriceId!, p.id]));
  for (const i of items) {
    const hit = byPrice.get(i.priceId);
    if (hit) return hit;
  }
  const byName = new Map(packages.map((p) => [p.name.trim().toLowerCase(), p.id]));
  for (const i of items) {
    const c = classifyProduct(i.productName);
    if (c.kind !== "package") continue;
    const hit = byName.get(c.package.toLowerCase());
    if (hit) return hit;
  }
  return null;
}
