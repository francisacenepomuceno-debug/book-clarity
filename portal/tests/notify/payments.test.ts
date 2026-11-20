import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { onPaymentFailedNotice, onUpcomingInvoice, runPaymentReminders } from "@/notify/payments";
import { resetDb } from "../helpers/db";

const sent = vi.hoisted(() => ({ list: [] as { key: string; to: { email?: string | null } }[] }));
vi.mock("@/notify/send", () => ({
  sendNotice: vi.fn(async (n: { key: string; to: { email?: string | null } }) => {
    if (sent.list.some((s) => s.key === n.key)) return "DUPLICATE";
    sent.list.push(n);
    return "SENT";
  }),
}));

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
let clientId: string;

async function failedInvoice(daysAgo: number, status = "open") {
  return db.invoice.create({
    data: {
      stripeInvoiceId: `in_${daysAgo}_${status}`, clientId, status, kind: "SUBSCRIPTION",
      subtotalCents: 65000, totalCents: 65000, amountPaidCents: 0,
      firstFailedAt: new Date(now.getTime() - daysAgo * DAY), periodStart: now, periodEnd: now,
    },
  });
}
const keys = () => sent.list.map((s) => s.key);

beforeEach(async () => {
  await resetDb();
  sent.list = [];
  process.env.PORTAL_BASE_URL = "https://portal.test";
  clientId = (await db.client.create({ data: { name: "Acme LLC", email: "a@acme.test", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "PAST_DUE" } })).id;
  await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER" } });
  await db.user.create({ data: { email: "alex@bc.test", name: "Alex", role: "ADMIN" } });
});

describe("payment reminders", () => {
  it("day 0 is sent when the payment fails, once", async () => {
    const inv = await failedInvoice(0);
    await onPaymentFailedNotice(inv.id);
    await onPaymentFailedNotice(inv.id);
    expect(keys()).toEqual([`failed:${inv.id}:0`]);
  });

  it("the daily run sends the reminder that's due (3, 7, 14) and nothing twice", async () => {
    const inv = await failedInvoice(3);
    await runPaymentReminders(now);
    await runPaymentReminders(now);
    expect(keys()).toEqual([`failed:${inv.id}:3`]);
    await runPaymentReminders(new Date(now.getTime() + 4 * DAY));
    expect(keys()).toEqual([`failed:${inv.id}:3`, `failed:${inv.id}:7`]);
  });

  it("stops once the invoice is paid", async () => {
    const inv = await failedInvoice(3);
    await db.invoice.update({ where: { id: inv.id }, data: { status: "paid" } });
    await runPaymentReminders(now);
    expect(keys()).toEqual([]);
  });

  it("day 21 alerts Owners (not Admins)", async () => {
    const inv = await failedInvoice(21);
    await runPaymentReminders(now);
    expect(keys().filter((k) => k.startsWith(`at-risk:${inv.id}:`))).toHaveLength(1);
    const alert = sent.list.find((s) => s.key.startsWith("at-risk"))!;
    expect(alert.to.email).toBe("jose@bc.test");
  });

  it("ACE-prepaid and ended clients get nothing", async () => {
    await db.client.update({ where: { id: clientId }, data: { acePrepaidUntil: new Date(now.getTime() + 30 * DAY) } });
    const inv = await failedInvoice(3);
    await onPaymentFailedNotice(inv.id);
    await runPaymentReminders(now);
    await db.client.update({ where: { id: clientId }, data: { acePrepaidUntil: null, endedAt: new Date(now.getTime() - DAY) } });
    await runPaymentReminders(now);
    expect(keys()).toEqual([]);
  });

  it("upcoming charge notice, once per billing period", async () => {
    const inv = { customer: "cus_1", subscription: "sub_1", amount_due: 66950, next_payment_attempt: Math.floor(now.getTime() / 1000) + 3 * 86400, period_end: 1798761600, collection_method: "charge_automatically" } as unknown as Stripe.Invoice;
    await onUpcomingInvoice(inv);
    await onUpcomingInvoice(inv);
    expect(keys()).toEqual(["upcoming:sub_1:1798761600"]);
  });
});

describe("cron route", () => {
  it("needs the secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    const { GET } = await import("@/app/api/cron/daily/route");
    expect((await GET(new Request("http://x/api/cron/daily"))).status).toBe(401);
    const ok = await GET(new Request("http://x/api/cron/daily", { headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
  });
});
