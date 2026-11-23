import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { matchPackage } from "@/domain/packageMatch";
import { syncClientsFromSnapshot } from "@/clients/queries";
import { resetDb } from "../helpers/db";

const pkgs = [
  { id: "ess", name: "Essentials", stripePriceId: "price_ess" },
  { id: "gro", name: "Growth", stripePriceId: null },
  { id: "ent", name: "Enterprise", stripePriceId: null },
  { id: "cus", name: "Enterprise Custom", stripePriceId: null },
];

describe("matchPackage", () => {
  it("matches by Stripe price first, then by product name; ignores fees and onboarding", () => {
    expect(matchPackage([{ priceId: "price_ess", productName: "Something renamed" }], pkgs)).toBe("ess");
    expect(matchPackage([{ priceId: "p1", productName: "3% Credit Card Fee" }, { priceId: "p2", productName: "Growth Package" }], pkgs)).toBe("gro");
    expect(matchPackage([{ priceId: "p3", productName: "Enterprise Package" }], pkgs)).toBe("ent");
    expect(matchPackage([{ priceId: "p4", productName: "Enterprise Custom Package" }], pkgs)).toBe("cus");
    expect(matchPackage([{ priceId: "p5", productName: "Growth Package - 6 Months" }], pkgs)).toBe("gro");
    expect(matchPackage([{ priceId: "p6", productName: "Onboarding Fee" }], pkgs)).toBeNull();
    expect(matchPackage([{ priceId: "p7", productName: "Tax prep" }], pkgs)).toBeNull();
  });
});

describe("client sync links packages", () => {
  beforeEach(resetDb);
  it("sets the package when empty and never overwrites one set by hand", async () => {
    const g = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } });
    const e = await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } });
    const row = (customerId: string, items: { priceId: string; productName: string }[]) =>
      ({ customerId, subscriptionId: `sub_${customerId}`, name: customerId, email: null, status: "CURRENT", packageName: "", sixMonthContract: false, packageMonthlyCents: 0, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true, paymentMethod: "", nextChargeDate: null, amountDueCents: 0, pastDueSince: null, priceItems: items }) as never;
    await db.client.create({ data: { name: "Manual", stripeCustomerId: "cus_m", packageId: e.id } });
    await syncClientsFromSnapshot([row("cus_new", [{ priceId: "x", productName: "Growth Package" }]), row("cus_m", [{ priceId: "x", productName: "Growth Package" }])]);
    expect((await db.client.findFirstOrThrow({ where: { stripeCustomerId: "cus_new" } })).packageId).toBe(g.id);
    expect((await db.client.findFirstOrThrow({ where: { stripeCustomerId: "cus_m" } })).packageId).toBe(e.id);
    const existing = await db.client.create({ data: { name: "Existing", stripeCustomerId: "cus_e" } });
    await syncClientsFromSnapshot([row("cus_e", [{ priceId: "x", productName: "Essentials Package" }])]);
    expect((await db.client.findUniqueOrThrow({ where: { id: existing.id } })).packageId).toBe(e.id);
  });
});
