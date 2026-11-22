import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { linkClientPackage, revertToListPrice } from "@/billing/pricing";
import { withPricing } from "@/clients/queries";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const stripeRef: { current: unknown } = { current: null };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));

type Item = { id: string; price: { id: string; unit_amount: number; product: { name: string } }; quantity: number };
function fakeStripe(items: Item[], discounts: unknown[] = []) {
  return { subscriptions: { retrieve: vi.fn(async () => ({ id: "sub_T", status: "active", discounts, items: { data: items } })), update: vi.fn(async () => ({ id: "sub_T" })) } };
}
const s = () => stripeRef.current as ReturnType<typeof fakeStripe>;
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@bc.test", name: "U", role, totpEnabled: true }, twoFactorVerified: true });
const custom500: Item = { id: "si_pkg", price: { id: "price_custom_500", unit_amount: 50000, product: { name: "Trent Aldridge monthly" } }, quantity: 1 };

let clientId = "";
let growth = "";
beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "u1", email: "u@bc.test", name: "U", role: "OWNER" } });
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_growth" } })).id;
  clientId = (await db.client.create({ data: { name: "Trent Aldridge", stripeCustomerId: "cus_T", stripeSubscriptionId: "sub_T", status: "CURRENT" } })).id;
  as("OWNER");
  stripeRef.current = fakeStripe([custom500]);
});

const live = (over: Partial<LiveClientRow> = {}): LiveClientRow => ({
  customerId: "cus_T", subscriptionId: "sub_T", name: "Trent Aldridge", email: null, status: "CURRENT", packageName: "Other: Trent Aldridge monthly",
  sixMonthContract: false, packageMonthlyCents: 50000, cardFeeMonthlyCents: 0, hasDiscount: false, autopay: true, paymentMethod: "ACH",
  nextChargeDate: null, amountDueCents: 0, pastDueSince: null, ...over,
});

describe("linking a client to a package", () => {
  it("Owners link by hand; the dashboard then shows the package and that the client is discounted", async () => {
    expect((await withPricing([live()]))[0]).toMatchObject({ discounted: false, listPriceCents: null });
    expect(await linkClientPackage(clientId, growth)).toEqual({ ok: true });
    expect((await withPricing([live()]))[0]).toMatchObject({ packageName: "Growth", listPriceCents: 65000, discounted: true });
    expect(await db.auditLog.count({ where: { action: "client_package_linked" } })).toBe(1);
  });
  it("Admins can't", async () => {
    as("ADMIN");
    expect((await linkClientPackage(clientId, growth)).ok).toBe(false);
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).packageId).toBeNull();
  });
});

describe("reverting to the original price", () => {
  it("moves the package line to the list price, removes discounts, charges nothing now, and ends portal discounts", async () => {
    await linkClientPackage(clientId, growth);
    await db.discount.create({ data: { clientId, kind: "AMOUNT", amountOffCents: 15000, months: 6, reason: "Jose", stripeCouponId: "bc_x", createdById: "u1" } });
    expect(await revertToListPrice(clientId)).toEqual({ ok: true, note: undefined });
    expect(s().subscriptions.update).toHaveBeenCalledWith(
      "sub_T",
      { items: [{ id: "si_pkg", price: "price_growth", quantity: 1 }], discounts: [], proration_behavior: "none" },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("bc-revert-price-sub_T") }),
    );
    expect(await db.discount.count({ where: { clientId, replacedAt: null } })).toBe(0);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "price_reverted_to_list" } });
    expect(a.before).toMatchObject({ priceId: "price_custom_500", unitAmount: 50000 });
  });

  it("works for Super Admin; Admins can't", async () => {
    await linkClientPackage(clientId, growth);
    as("ADMIN");
    expect((await revertToListPrice(clientId)).ok).toBe(false);
    as("SUPER_ADMIN");
    expect((await revertToListPrice(clientId)).ok).toBe(true);
  });

  it("needs a linked package with a Stripe price, and one package line", async () => {
    expect(await revertToListPrice(clientId)).toMatchObject({ ok: false, error: expect.stringMatching(/Link this client to a package/) });
    await db.package.update({ where: { id: growth }, data: { stripePriceId: null } });
    await linkClientPackage(clientId, growth);
    expect(await revertToListPrice(clientId)).toMatchObject({ ok: false, error: expect.stringMatching(/no Stripe price/) });
    await db.package.update({ where: { id: growth }, data: { stripePriceId: "price_growth" } });
    stripeRef.current = fakeStripe([custom500, { ...custom500, id: "si_2" }]);
    expect(await revertToListPrice(clientId)).toMatchObject({ ok: false, error: expect.stringMatching(/2 package lines/) });
    expect(s().subscriptions.update).not.toHaveBeenCalled();
  });

  it("refuses when already on the list price, and warns about a fixed card-fee line", async () => {
    await linkClientPackage(clientId, growth);
    stripeRef.current = fakeStripe([{ ...custom500, price: { id: "price_growth", unit_amount: 65000, product: { name: "Growth Package" } } }]);
    expect(await revertToListPrice(clientId)).toMatchObject({ ok: false, error: expect.stringMatching(/already on the Growth list price/) });
    stripeRef.current = fakeStripe([custom500, { id: "si_fee", price: { id: "price_fee", unit_amount: 1500, product: { name: "3% Credit Card Fee" } }, quantity: 1 }]);
    const r = await revertToListPrice(clientId);
    expect(r).toMatchObject({ ok: true, note: expect.stringMatching(/fixed card-fee line of \$15\.00/) });
    expect((s().subscriptions.update.mock.calls as unknown as [string, { items: unknown }][])[0][1].items).toEqual([{ id: "si_pkg", price: "price_growth", quantity: 1 }]);
  });
});
