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
    await db.client.update({ where: { stripeCustomerId: "cus_1" }, data: { type: "ACE" } });
    await syncClientsFromSnapshot([row()]);
    expect((await db.client.findFirstOrThrow()).type).toBe("ACE");
  });
});
