import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { cancelPriceIncrease, runPriceChanges, schedulePriceIncrease } from "@/billing/priceChanges";
import { addMonth, firstBillOnOrAfter } from "@/domain/priceChange";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const stripeRef: { current: unknown } = { current: null };
vi.mock("@/stripe/client", () => ({ getStripe: () => stripeRef.current }));
const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));

const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
type Sub = { id: string; amount: number; periodEnd: string; discounts?: unknown[] };
function fakeStripe(subs: Sub[]) {
  const byId = new Map(subs.map((s) => [s.id, s]));
  return {
    subs: byId,
    prices: {
      retrieve: vi.fn(async () => ({ id: "price_growth_650", product: "prod_growth", currency: "usd", recurring: { interval: "month", interval_count: 1 } })),
      create: vi.fn(async (p: { unit_amount: number }) => ({ id: `price_new_${p.unit_amount}` })),
    },
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        const s = byId.get(id)!;
        return {
          id,
          status: "active",
          discounts: s.discounts ?? [],
          default_payment_method: { type: "us_bank_account" },
          customer: { id: "cus" },
          items: { data: [{ id: `si_${id}`, quantity: 1, current_period_end: ts(s.periodEnd), price: { id: `price_${s.amount}`, unit_amount: s.amount, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { id: "prod_growth", name: "Growth Package" } } }] },
        };
      }),
      update: vi.fn(async () => ({})),
    },
  };
}
const s = () => stripeRef.current as ReturnType<typeof fakeStripe>;
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "jose@bc.test", name: "Jose", role, totpEnabled: true }, twoFactorVerified: true });

let pkg = "";
const client = async (name: string, sub: string) => (await db.client.create({ data: { name, email: `${sub}@x.co`, packageId: pkg, stripeSubscriptionId: sub, stripeCustomerId: `cus_${sub}`, status: "CURRENT" } })).id;

beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "u1", email: "jose@bc.test", name: "Jose", role: "OWNER" } });
  pkg = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_growth_650" } })).id;
  as("OWNER");
  ghl.upsert.mockReset().mockResolvedValue("ct");
  ghl.send.mockReset().mockResolvedValue("m");
  stripeRef.current = fakeStripe([]);
});

describe("dates", () => {
  it("first bill on or after the start date, month by month", () => {
    expect(firstBillOnOrAfter(new Date("2026-12-20T15:00:00Z"), new Date("2027-01-01T05:00:00Z")).toISOString()).toBe("2027-01-20T15:00:00.000Z");
    expect(firstBillOnOrAfter(new Date("2027-01-05T15:00:00Z"), new Date("2027-01-01T05:00:00Z")).toISOString()).toBe("2027-01-05T15:00:00.000Z");
    expect(addMonth(new Date("2027-01-31T12:00:00Z")).toISOString()).toBe("2027-02-28T12:00:00.000Z");
  });
});

describe("scheduling a price increase", () => {
  const now = new Date("2026-11-22T15:00:00Z");
  it("Owners schedule it: a new Stripe price on the same product, and the package is unchanged until the start date", async () => {
    const r = await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, now);
    expect(r.ok).toBe(true);
    expect(s().prices.create).toHaveBeenCalledWith(expect.objectContaining({ product: "prod_growth", unit_amount: 70000, currency: "usd", recurring: { interval: "month", interval_count: 1 } }), expect.anything());
    const c = await db.priceChange.findFirstOrThrow();
    expect(c).toMatchObject({ oldMonthlyCents: 65000, newMonthlyCents: 70000, oldStripePriceId: "price_growth_650", newStripePriceId: "price_new_70000" });
    expect((await db.package.findUniqueOrThrow({ where: { id: pkg } })).monthlyPriceCents).toBe(65000);
    expect(await db.auditLog.count({ where: { action: "price_change_scheduled" } })).toBe(1);
  });

  it("needs 30 days' notice, one change at a time, and Owner or Super Admin", async () => {
    expect(await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2026-12-10" }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/at least 30 days/) });
    as("ADMIN");
    expect((await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, now)).ok).toBe(false);
    as("SUPER_ADMIN");
    expect((await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, now)).ok).toBe(true);
    expect(await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 72000, startsOn: "2027-02-01" }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/already has a price change/) });
  });

  it("refuses Custom packages and packages without a Stripe price", async () => {
    await db.package.update({ where: { id: pkg }, data: { stripePriceId: null } });
    expect(await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/Stripe price first/) });
    await db.package.update({ where: { id: pkg }, data: { isCustom: true } });
    expect(await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/Custom packages/) });
  });
});

describe("the daily run", () => {
  const scheduledOn = new Date("2026-11-22T15:00:00Z");
  let full = "";
  let discounted = "";
  let custom = "";
  beforeEach(async () => {
    full = await client("Full Price", "sub_full");
    discounted = await client("With Coupon", "sub_disc");
    custom = await client("Custom 500", "sub_cust");
    stripeRef.current = fakeStripe([
      // Bills on the 20th: Dec 20 is still old price; Jan 20 is the first bill on/after Jan 1.
      { id: "sub_full", amount: 65000, periodEnd: "2026-12-20T15:00:00Z" },
      { id: "sub_disc", amount: 65000, periodEnd: "2026-12-20T15:00:00Z", discounts: ["di_1"] },
      { id: "sub_cust", amount: 50000, periodEnd: "2026-12-20T15:00:00Z" },
    ]);
    await schedulePriceIncrease({ packageId: pkg, newMonthlyCents: 70000, startsOn: "2027-01-01" }, scheduledOn);
  });

  it("notices 30 days before the first new-price bill, moves the client after their last old-price bill, and leaves discounted and custom clients alone", async () => {
    // Nov 25: Jan 20 is more than 30 days away.
    await runPriceChanges(new Date("2026-11-25T15:00:00Z"));
    expect(await db.notification.count()).toBe(0);

    // Dec 21: the Dec 20 bill was the last at the old price; the period now ends Jan 20. Notice is due (Dec 21), then the move.
    s().subs.get("sub_full")!.periodEnd = "2027-01-20T15:00:00Z";
    s().subs.get("sub_disc")!.periodEnd = "2027-01-20T15:00:00Z";
    s().subs.get("sub_cust")!.periodEnd = "2027-01-20T15:00:00Z";
    const r = await runPriceChanges(new Date("2026-12-21T15:00:00Z"));
    expect(r).toMatchObject({ noticed: 1, moved: 1, switched: 0 });
    const notes = await db.notification.findMany();
    expect(notes.map((n) => [n.key, n.clientId])).toEqual([[expect.stringMatching(/^price-increase:/), full]]);
    const mail = (ghl.send.mock.calls.find((c) => (c[0] as { html?: string }).html)![0] as { html: string }).html;
    expect(mail).toContain("$650.00");
    expect(mail).toContain("$700.00");
    expect(mail).toContain("January 20, 2027");
    expect(s().subscriptions.update).toHaveBeenCalledTimes(1);
    expect(s().subscriptions.update).toHaveBeenCalledWith(
      "sub_full",
      { items: [{ id: "si_sub_full", price: "price_new_70000", quantity: 1 }], proration_behavior: "none" },
      { idempotencyKey: expect.stringContaining("bc-price-change-move-") },
    );
    const move = await db.priceChangeMove.findFirstOrThrow();
    expect(move).toMatchObject({ clientId: full, fromCents: 65000 });
    expect(move.startsOn.toISOString()).toBe("2027-01-20T15:00:00.000Z");
    expect(await db.priceChangeMove.count({ where: { clientId: { in: [discounted, custom] } } })).toBe(0);

    // Running again changes nothing for the moved client.
    await runPriceChanges(new Date("2026-12-22T15:00:00Z"));
    expect(s().subscriptions.update).toHaveBeenCalledTimes(1);
    expect(await db.notification.count()).toBe(1);
  });

  it("a client billed on the 5th gets notice early December and moves after the Dec 5 bill", async () => {
    s().subs.get("sub_full")!.periodEnd = "2026-12-05T15:00:00Z";
    // Dec 4: the next bill (Dec 5) is still old price, and Jan 5 is more than 30 days away.
    await runPriceChanges(new Date("2026-12-04T15:00:00Z"));
    expect(await db.notification.count()).toBe(0);
    // Dec 6 (Jan 5 − 30 days): after the Dec 5 bill the period ends Jan 5, so the notice goes and the client moves.
    s().subs.get("sub_full")!.periodEnd = "2027-01-05T15:00:00Z";
    expect(await runPriceChanges(new Date("2026-12-06T15:00:00Z"))).toMatchObject({ noticed: 1, moved: 1 });
  });

  it("switches the package on the start date, so new clients get the new price", async () => {
    await runPriceChanges(new Date("2026-12-31T15:00:00Z"));
    expect((await db.package.findUniqueOrThrow({ where: { id: pkg } })).monthlyPriceCents).toBe(65000);
    expect(await runPriceChanges(new Date("2027-01-01T06:00:00Z"))).toMatchObject({ switched: 1 });
    expect(await db.package.findUniqueOrThrow({ where: { id: pkg } })).toMatchObject({ monthlyPriceCents: 70000, stripePriceId: "price_new_70000" });
    expect(await runPriceChanges(new Date("2027-01-02T06:00:00Z"))).toMatchObject({ switched: 0 });
  });

  it("while client notices are off before launch, the notice is held (recorded) and the move still happens", async () => {
    await db.setting.upsert({ where: { key: "launch" }, create: { key: "launch", value: { noticesOn: false, checks: {} } }, update: { value: { noticesOn: false, checks: {} } } });
    s().subs.get("sub_full")!.periodEnd = "2027-01-20T15:00:00Z";
    const r = await runPriceChanges(new Date("2026-12-21T15:00:00Z"));
    expect(r.moved).toBe(1);
    expect((await db.notification.findFirstOrThrow()).status).toBe("SKIPPED");
    expect(ghl.send).not.toHaveBeenCalled();
  });

  it("can be cancelled until anyone has moved; not after", async () => {
    const c = await db.priceChange.findFirstOrThrow();
    s().subs.get("sub_full")!.periodEnd = "2027-01-20T15:00:00Z";
    await runPriceChanges(new Date("2026-12-21T15:00:00Z"));
    expect(await cancelPriceIncrease(c.id)).toMatchObject({ ok: false, error: expect.stringMatching(/already started/) });
  });

  it("a cancelled change does nothing", async () => {
    const c = await db.priceChange.findFirstOrThrow();
    expect(await cancelPriceIncrease(c.id)).toEqual({ ok: true });
    s().subs.get("sub_full")!.periodEnd = "2027-01-20T15:00:00Z";
    expect(await runPriceChanges(new Date("2027-01-02T15:00:00Z"))).toMatchObject({ switched: 0, noticed: 0, moved: 0 });
    expect((await db.package.findUniqueOrThrow({ where: { id: pkg } })).monthlyPriceCents).toBe(65000);
  });
});
