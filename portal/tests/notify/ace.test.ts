import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { answerContinuation, continuationToken, markContinuing, markEnded } from "@/ace/continuation";
import { runAceBatchReminders, runAceNotices } from "@/notify/ace";
import { setAceContactEmail, setAceCustomer } from "@/ace/batches";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };

const sent = vi.hoisted(() => ({ list: [] as { key: string; to: { email?: string | null } }[] }));
vi.mock("@/notify/send", () => ({
  sendNotice: vi.fn(async (n: { key: string; to: { email?: string | null } }) => {
    if (sent.list.some((s) => s.key === n.key)) return "DUPLICATE";
    sent.list.push(n);
    return "SENT";
  }),
}));
const stripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_new" })), retrieve: vi.fn(async (id: string) => ({ id })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs", url: "https://checkout.stripe.test/cs" })), expire: vi.fn(async () => ({})) } },
};
vi.mock("@/stripe/client", () => ({ getStripe: () => stripe }));

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
const keys = () => sent.list.map((s) => s.key);
let pkg: string;

async function aceClient(daysLeft: number, from: Date = now) {
  const until = new Date(from.getTime() + daysLeft * DAY);
  const c = await db.client.create({ data: { name: "Acme LLC", email: "a@acme.test", type: "ACE", status: "PREPAID_ACE", acePrepaidUntil: until, packageId: pkg } });
  const b = await db.aceBatch.create({ data: { purchasedAt: now, totalCents: 1, createdById: "u", paidAt: now } });
  const s = await db.aceSlot.create({ data: { batchId: b.id, packageId: pkg, clientId: c.id, startDate: now, prepaidUntil: until } });
  await db.client.update({ where: { id: c.id }, data: { aceSlotId: s.id } });
  return c.id;
}

beforeEach(async () => {
  await resetDb();
  sent.list = [];
  sessionRef.current = OWNER;
  process.env.PORTAL_BASE_URL = "https://portal.test";
  pkg = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0, stripePriceId: "price_g" } })).id;
  await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER" } });
});

describe("ACE month-6 notices", () => {
  it("60-day notice once; the 30-day reminder is skipped after the client said Yes", async () => {
    const id = await aceClient(59);
    await runAceNotices(now);
    await runAceNotices(now);
    expect(keys()).toEqual([`ace-ending:${id}:60`]);
    await answerContinuation(continuationToken(id), "YES", "https://portal.test");
    await runAceNotices(new Date(now.getTime() + 30 * DAY));
    expect(keys()).toEqual([`ace-ending:${id}:60`]);
  });

  it("nothing more than 60 days out; only the latest due notice if the client was added late", async () => {
    await aceClient(90);
    await runAceNotices(now);
    expect(keys()).toEqual([]);
    const late = await aceClient(20);
    await runAceNotices(now);
    expect(keys()).toEqual([`ace-ending:${late}:30`]);
  });

  it("a No keeps reminders going and still allows Yes up to the last day", async () => {
    const id = await aceClient(25);
    const token = continuationToken(id);
    const no = await answerContinuation(token, "NO", "https://portal.test");
    expect(no.message).toMatch(/thank/i);
    const c = await db.client.findUniqueOrThrow({ where: { id } });
    expect(c).toMatchObject({ clientAnswer: "NO", continuationDecision: null, endedAt: null });
    await runAceNotices(new Date(now.getTime() + 12 * DAY));
    expect(keys()).toContain(`ace-ending:${id}:14`);
    const yes = await answerContinuation(token, "YES", "https://portal.test");
    expect(yes.url).toBe("https://checkout.stripe.test/cs");
    expect(await db.client.findUniqueOrThrow({ where: { id } })).toMatchObject({ clientAnswer: "YES", continuationDecision: "CONTINUING" });
    const actions = (await db.auditLog.findMany({ where: { entityId: id }, orderBy: { at: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["ace_client_answered_no", "ace_client_answered_yes"]));
  });

  it("the link stops working once an Owner confirms the end, and after the end date unless continuing", async () => {
    const id = await aceClient(10);
    const token = continuationToken(id);
    await markEnded(id);
    expect((await answerContinuation(token, "YES", "https://portal.test")).error).toMatch(/no longer/);
    const id2 = await aceClient(-1);
    expect((await answerContinuation(continuationToken(id2), "YES", "https://portal.test")).error).toMatch(/no longer/);
  });

  it("an Owner can win a client back after confirming the end, up to the last day", async () => {
    const id = await aceClient(10);
    await markEnded(id);
    expect((await markContinuing(id, "https://portal.test")).ok).toBe(true);
    expect(await db.client.findUniqueOrThrow({ where: { id } })).toMatchObject({ continuationDecision: "CONTINUING", endedAt: null });
  });

  it("alerts Owners once the period has ended with no decision", async () => {
    const id = await aceClient(-2);
    await runAceNotices(now);
    expect(keys()).toContain(`ace-no-decision:${id}:${(await db.user.findFirstOrThrow()).id}`);
  });
});

describe("ACE batch reminders", () => {
  it("reminds ACE's billing contact at 7 and 14 days, not once paid", async () => {
    await setAceCustomer("cus_ace");
    await setAceContactEmail("billing@ace.test");
    const b = await db.aceBatch.create({ data: { purchasedAt: now, totalCents: 2600000, createdById: "u", stripeInvoiceId: "in_ace", invoiceSentAt: new Date(now.getTime() - 8 * DAY) } });
    await runAceBatchReminders(now);
    await runAceBatchReminders(now);
    expect(keys()).toEqual([`ace-batch:${b.id}:7`]);
    expect(sent.list[0].to.email).toBe("billing@ace.test");
    await db.aceBatch.update({ where: { id: b.id }, data: { paidAt: now } });
    await runAceBatchReminders(new Date(now.getTime() + 7 * DAY));
    expect(keys()).toEqual([`ace-batch:${b.id}:7`]);
  });
});
