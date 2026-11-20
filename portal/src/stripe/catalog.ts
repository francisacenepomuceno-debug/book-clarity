export type ProductClass =
  | { kind: "card_fee" }
  | { kind: "onboarding" }
  | { kind: "package"; package: "Essentials" | "Growth" | "Enterprise" | "Enterprise Custom"; sixMonth: boolean }
  | { kind: "other"; name: string };

/** Maps a Stripe product name to a portal concept. Name-based until packages are configured in Settings (Plan 1). */
export function classifyProduct(name: string): ProductClass {
  const n = name.toLowerCase();
  if (n.includes("credit card fee")) return { kind: "card_fee" };
  if (n.includes("onboarding")) return { kind: "onboarding" };
  const sixMonth = /6\s*months?/.test(n);
  if (n.includes("enterprise") && n.includes("custom")) return { kind: "package", package: "Enterprise Custom", sixMonth };
  if (n.includes("enterprise") && n.includes("package")) return { kind: "package", package: "Enterprise", sixMonth };
  if (n.includes("growth")) return { kind: "package", package: "Growth", sixMonth };
  if (n.includes("essential")) return { kind: "package", package: "Essentials", sixMonth };
  return { kind: "other", name };
}
