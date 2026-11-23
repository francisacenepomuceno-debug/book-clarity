import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { markPaidOutside, outsideBills, runOutsidePaymentReminders, setPaysOutsideStripe } from "@/billing/outsidePayments";
import { remindable } from "@/notify/payments";
import { dashboardAlerts } from "@/reports/alerts";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const ghl = vi.hoisted(() => ({ upsert: vi.fn(async () => "ct"), send: vi.fn(async () => "m") }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@bc.test", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
let periodEnd = "2026-12-10T15:00:00Z";
const stripe = {
  subscriptions: { retrieve: vi.fn(async () => ({ id: "sub_J", status: "active", pause_collection: null, days_until_due: 7, items: { data: [{ current_period_end: ts(periodEnd), quantity: 1, price: { unit_amount: 35000 } }] } })) },
  invoices: { pay: vi.fn(async () => ({ status: "paid" })) },
};
const s = stripe as unknown as Stripe;

let clientId = "";
beforeEach(async () => {
  await resetDb();
  periodEnd = "2026-12-10T15:00:00Z";
  stripe.invoices.pay.mockClear();
  ghl.send.mockClear();
  await db.user.create({ data: { id: "u1", email: "u@bc.test", name: "U", role: "OWNER" } });
  await db.user.create({ data: { id: "sa", email: "sa@bc.test", name: "Francis", role: "SUPER_ADMIN" } });
  clientId = (await db.client.create({ data: { name: "James Mansingh", email: "james@x.co", stripeCustomerId: "cus_J", stripeSubscriptionId: "sub_J", status: "CURRENT" } })).id;
  as("OWNER");
});

const openBill = (dueAt: string, id = "in_J1") =>
  db.invoice.create({ data: { stripeInvoiceId: id, clientId, status: "open", kind: "SUBSCRIPTION", subtotalCents: 35000, totalCents: 35000, periodStart: new Date("2026-11-03T15:00:00Z"), periodEnd: new Date("2026-12-03T15:00:00Z"), billedAt: new Date("2026-11-03T15:00:00Z"), dueAt: new Date(dueAt), firstFailedAt: new Date("2026-11-04T15:00:00Z") } });

describe("clients who pay outside Stripe", () => {
  it("only Owners and the Super Admin can set it, and a method is required", async () => {
    expect((await setPaysOutsideStripe(clientId, true, null)).ok).toBe(false);
    as("ADMIN");
    expect((await setPaysOutsideStripe(clientId, true, "Zelle")).ok).toBe(false);
    as("SUPER_ADMIN");
    expect(await setPaysOutsideStripe(clientId, true, "Zelle")).toEqual({ ok: true });
    expect(await db.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({ paysOutsideStripe: true, outsidePaymentMethod: "Zelle" });
  });

  it("get no automatic client payment emails and are never auto-suspended", async () => {
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(remindable(c, new Date())).toBe(true);
    await setPaysOutsideStripe(clientId, true, "Check");
    expect(remindable(await db.client.findUniqueOrThrow({ where: { id: clientId } }), new Date())).toBe(false);
  });

  it("lists open bills and predicts the next one from the subscription (billing date + days until due)", async () => {
    await setPaysOutsideStripe(clientId, true, "Zelle");
    await openBill("2026-11-10T15:00:00Z");
    const bills = await outsideBills(new Date("2026-11-23T15:00:00Z"), s);
    expect(bills.map((b) => [b.invoiceId ? "open" : "next", b.amountCents, b.daysUntil, b.state])).toEqual([
      ["open", 35000, -13, "overdue"],
      ["next", 35000, 24, "upcoming"], // billed Dec 10, due 7 days later (Dec 17)
    ]);
  });

  it("reminds the Super Admin 7 days before, 1 day before and on the due date, once each", async () => {
    await setPaysOutsideStripe(clientId, true, "Zelle");
    await openBill("2026-12-01T17:00:00Z");
    periodEnd = "2027-01-01T15:00:00Z"; // next bill is far off
    const keys = async () => (await db.notification.findMany({ orderBy: { createdAt: "asc" } })).map((n) => [n.key.split(":")[3], n.to]);
    await runOutsidePaymentReminders(new Date("2026-11-23T15:00:00Z"), s); // 8 days before: nothing
    expect(await keys()).toEqual([]);
    await runOutsidePaymentReminders(new Date("2026-11-24T15:00:00Z"), s); // 7 days before
    await runOutsidePaymentReminders(new Date("2026-11-25T15:00:00Z"), s); // nothing new
    await runOutsidePaymentReminders(new Date("2026-11-30T15:00:00Z"), s); // 1 day before
    await runOutsidePaymentReminders(new Date("2026-12-01T15:00:00Z"), s); // due today
    await runOutsidePaymentReminders(new Date("2026-12-01T20:00:00Z"), s); // same day again: nothing new
    expect(await keys()).toEqual([["7", "sa@bc.test"], ["1", "sa@bc.test"], ["0", "sa@bc.test"]]);
    const mail = ((ghl.send.mock.calls as unknown as [{ subject: string }][]).at(-1)![0]).subject;
    expect(mail).toMatch(/James Mansingh is due today/);
  });

  it("shows on the dashboard's Needs attention list when due within 7 days", async () => {
    await setPaysOutsideStripe(clientId, true, "PayPal");
    await openBill(new Date(Date.now() + 3 * 86400_000).toISOString());
    const g = (await dashboardAlerts()).find((x) => x.kind === "outsidePayments");
    expect(g?.items.map((i) => i.name)).toEqual(["James Mansingh"]);
  });

  it("marking paid: Stripe invoice paid out of band, payment recorded, counts as paid", async () => {
    await setPaysOutsideStripe(clientId, true, "Zelle");
    const inv = await openBill("2026-11-10T15:00:00Z");
    as("ADMIN");
    expect((await markPaidOutside(inv.id, { paidOn: "2026-11-20", method: "Zelle", reference: "ZL-1" }, s)).ok).toBe(false);
    as("SUPER_ADMIN");
    expect(await markPaidOutside(inv.id, { paidOn: "2026-11-20", method: "Zelle", reference: "ZL-1" }, s)).toEqual({ ok: true });
    expect(stripe.invoices.pay).toHaveBeenCalledWith("in_J1", { paid_out_of_band: true }, { idempotencyKey: "bc-paid-outside-in_J1" });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: "paid", amountPaidCents: 35000, paymentMethodType: "outside", outsideMethod: "Zelle", outsideReference: "ZL-1" });
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).status).toBe("CURRENT");
    expect((await markPaidOutside(inv.id, { paidOn: "2026-11-20", method: "Zelle", reference: "" }, s)).ok).toBe(false); // already paid
  });
});
