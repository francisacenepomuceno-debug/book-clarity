import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { scopeRow, syncClientsFromSnapshot } from "@/clients/queries";
import type { LiveClientRow } from "@/stripe/mapSubscription";
import { resetDb } from "../helpers/db";

const row = (over: Partial<LiveClientRow> = {}): LiveClientRow => ({
  customerId: "cus_1",
  subscriptionId: "sub_1",
  name: "Acme LLC",
  email: "a@acme.test",
  status: "PAST_DUE",
  packageName: "Growth",
  sixMonthContract: false,
  packageMonthlyCents: 65000,
  cardFeeMonthlyCents: 1950,
  hasDiscount: true,
  autopay: true,
  paymentMethod: "Credit card",
  nextChargeDate: new Date("2026-12-01"),
  amountDueCents: 66950,
  pastDueSince: new Date("2026-11-10"),
  ...over,
});

const MONEY_KEYS = ["packageMonthlyCents", "cardFeeMonthlyCents", "hasDiscount", "autopay", "paymentMethod", "amountDueCents", "email", "customerId"];

describe("scopeRow", () => {
  it("Admins get no money, payment or contact fields at all", () => {
    const r = scopeRow(row(), "ADMIN");
    for (const k of MONEY_KEYS) expect(r, k).not.toHaveProperty(k);
    expect(r).toMatchObject({ subscriptionId: "sub_1", name: "Acme LLC", status: "PAST_DUE", packageName: "Growth" });
  });
  it("Owners get everything", () => {
    const r = scopeRow(row(), "OWNER");
    for (const k of MONEY_KEYS) expect(r, k).toHaveProperty(k);
  });
});

describe("syncClientsFromSnapshot", () => {
  beforeEach(resetDb);

  it("creates client rows by Stripe customer, then refreshes only contact details", async () => {
    await syncClientsFromSnapshot([row()]);
    await syncClientsFromSnapshot([row({ name: "Acme Renamed", status: "CURRENT" })]);
    const all = await db.client.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Acme Renamed", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "PAST_DUE" });
  });

  it("links only one subscription per customer (prefers the most urgent)", async () => {
    await syncClientsFromSnapshot([row({ subscriptionId: "sub_a", status: "CURRENT" }), row({ subscriptionId: "sub_b", status: "PAUSED" })]);
    const all = await db.client.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].stripeSubscriptionId).toBe("sub_a");
  });

  it("keeps Direct/ACE and other portal-owned fields untouched", async () => {
    await syncClientsFromSnapshot([row()]);
    await db.client.updateMany({ where: { stripeCustomerId: "cus_1" }, data: { type: "ACE" } });
    await syncClientsFromSnapshot([row()]);
    expect((await db.client.findFirstOrThrow()).type).toBe("ACE");
  });
});

describe("ACE clients on the dashboard", () => {
  beforeEach(resetDb);
  it("lists ACE clients without a subscription, scoped like other rows", async () => {
    const { aceDashboardRows, withClientTypes } = await import("@/clients/queries");
    const pkg = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } });
    await db.client.create({ data: { name: "Ace Co", type: "ACE", status: "PREPAID_ACE", packageId: pkg.id, acePrepaidUntil: new Date("2027-05-01") } });
    await db.client.create({ data: { name: "Gone Co", type: "ACE", status: "ENDED", endedAt: new Date() } });
    const rows = await aceDashboardRows();
    expect(rows.map((r) => [r.name, r.status, r.packageName, r.clientType, r.paymentMethod])).toEqual([["Ace Co", "PREPAID_ACE", "Growth", "ACE", "Prepaid by ACE"]]);
    const admin = scopeRow(rows[0], "ADMIN");
    expect(admin).toMatchObject({ clientType: "ACE", status: "PREPAID_ACE" });
    expect(admin).not.toHaveProperty("paymentMethod");

    await db.client.create({ data: { name: "Stripe Co", type: "ACE", stripeSubscriptionId: "sub_9", status: "CURRENT" } });
    const typed = await withClientTypes([row({ subscriptionId: "sub_9" })]);
    expect(typed[0].clientType).toBe("ACE");
  });
});
