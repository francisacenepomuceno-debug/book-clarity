import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { upsertInvoiceFromStripe } from "@/stripe/handlers/invoice";
import { planImport, applyImport } from "@/migration/commissionImport";
import { invoice, ts } from "../stripe/fixtures";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "sa", email: "sa@x.co", name: "SA", role: "SUPER_ADMIN" } });
  sessionRef.current = { user: { id: "sa", email: "sa@x.co", name: "SA", role: "SUPER_ADMIN", totpEnabled: true }, twoFactorVerified: true };
});

describe("card fee after a discount", () => {
  it("a coupon that also reduces the card-fee line leaves the full discounted package amount for commission", async () => {
    // Example: $350 Essentials + $10.50 card fee, 20% off both: pays $288.40 = $280 + $8.40.
    await db.client.create({ data: { name: "Acme Co", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    await upsertInvoiceFromStripe(invoice({
      status: "paid", subtotal: 36050, total: 28840, amount_paid: 28840,
      total_discount_amounts: [{ amount: 7210, discount: "di_1" }],
      lines: { data: [
        { id: "il_1", amount: 35000, description: "1 × Essential Package", metadata: {}, discount_amounts: [{ amount: 7000, discount: "di_1" }] },
        { id: "il_2", amount: 1050, description: "1 × 3% Credit Card Fee", metadata: {}, discount_amounts: [{ amount: 210, discount: "di_1" }] },
      ] },
      status_transitions: { paid_at: ts("2026-11-16"), finalized_at: ts("2026-11-16") },
    }));
    const row = await db.invoice.findFirstOrThrow();
    expect(row.cardFeeCents).toBe(840);
    expect(row.amountPaidCents - row.cardFeeCents).toBe(28000);
  });
});

describe("commission import after 'Load invoice history'", () => {
  it("payments on or after the settled date earn, even though the history load copied them", async () => {
    const pkg = await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } });
    const c = await db.client.create({ data: { name: "Acme LLC", stripeCustomerId: "cus_h", stripeSubscriptionId: "sub_h", packageId: pkg.id, status: "CURRENT" } });
    const paid = (id: string, at: string) => db.invoice.create({ data: { stripeInvoiceId: id, clientId: c.id, stripeSubscriptionId: "sub_h", status: "paid", kind: "SUBSCRIPTION", subtotalCents: 35000, totalCents: 35000, amountPaidCents: 35000, paidAt: new Date(at), periodStart: new Date(at), periodEnd: new Date(at), backfilled: true } });
    await paid("in_oct", "2026-10-05T15:00:00Z");
    await paid("in_nov", "2026-11-05T15:00:00Z");

    const csv = "client,executive_1,rate_1,months_already_earned\ncus_h,ExecA,10%,3\n";
    const plan = await planImport(csv, { createMissingExecutives: true, settledThrough: "2026-11-01" });
    expect(plan.ready[0].willPost).toEqual(["2026-11"]);
    await applyImport(plan.ready);

    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_oct" } })).backfilled).toBe(true);
    expect((await db.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_nov" } })).backfilled).toBe(false);
    const lines = await db.commissionEntry.findMany();
    expect(lines.map((l) => [l.month, l.windowIndex, l.amountCents])).toEqual([["2026-11", 4, 3500]]);
  });

  it("an additional package row also earns on its payments since the settled date", async () => {
    const c = await db.client.create({ data: { name: "Beta Co", stripeCustomerId: "cus_s", stripeSubscriptionId: "sub_main", status: "CURRENT" } });
    await db.clientSubscription.create({ data: { clientId: c.id, stripeSubscriptionId: "sub_main" } });
    await db.clientSubscription.create({ data: { clientId: c.id, stripeSubscriptionId: "sub_arap", productName: "AR/AP" } });
    await db.invoice.create({ data: { stripeInvoiceId: "in_arap", clientId: c.id, stripeSubscriptionId: "sub_arap", status: "paid", kind: "SUBSCRIPTION", subtotalCents: 60000, totalCents: 60000, amountPaidCents: 60000, paidAt: new Date("2026-11-19T15:00:00Z"), periodStart: new Date(), periodEnd: new Date(), backfilled: true } });
    const csv = "client,executive_1,rate_1,months_already_earned\ncus_s,ExecA,10%,7\nsub_arap,,,6\n";
    await applyImport((await planImport(csv, { createMissingExecutives: true, settledThrough: "2026-11-01" })).ready);
    const lines = await db.commissionEntry.findMany();
    expect(lines.map((l) => [l.windowIndex, l.amountCents])).toEqual([[7, 6000]]);
  });
});
