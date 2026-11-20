import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { applyImport, planImport } from "@/migration/commissionImport";
import { createBatch } from "@/ace/batches";
import { runSuspensions } from "@/billing/suspension";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));

const d = (s: string) => new Date(s);
let growth = "";
beforeEach(async () => {
  await resetDb();
  sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } })).id;
  await db.executive.create({ data: { name: "Jose" } });
  await db.executive.create({ data: { name: "Albert", active: false } });
});

async function clientWithWebhookPayments() {
  const c = await db.client.create({ data: { name: "Acme LLC", stripeCustomerId: "cus_acme", packageId: growth } });
  for (const m of ["07", "08", "09"]) {
    await db.invoice.create({ data: { stripeInvoiceId: `in_${m}`, clientId: c.id, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 65000, totalCents: 65000, amountPaidCents: 65000, paidAt: d(`2026-${m}-05T15:00:00Z`), periodStart: d(`2026-${m}-05T12:00:00Z`), periodEnd: d(`2026-${m}-05T12:00:00Z`), billedAt: d(`2026-${m}-05T12:00:00Z`) } });
  }
  return c;
}

describe("#1 import never pays commission twice for months settled outside the portal", () => {
  it("previews the commission Apply would post, and payments before the 'settled through' date don't earn", async () => {
    await clientWithWebhookPayments();
    const csv = "client,executive_1,rate_1,months_already_earned\nAcme LLC,Jose,10,3";
    const noDate = await planImport(csv, { createMissingExecutives: false });
    expect(noDate.ready[0].willPost).toEqual(["2026-07", "2026-08", "2026-09"]);
    const plan = await planImport(csv, { createMissingExecutives: false, settledThrough: "2026-10-01" });
    expect(plan.ready[0].willPost).toEqual([]);
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 1, failed: [] });
    expect(await db.commissionEntry.count()).toBe(0);
    expect(await db.invoice.count({ where: { backfilled: true } })).toBe(3);
  });
});

describe("#2 a row is checked fully before anything is written", () => {
  it("inactive executive, 3-decimal rate and impossible dates are problems at planning; the client is untouched", async () => {
    await db.client.create({ data: { name: "Beta", stripeCustomerId: "cus_b" } });
    const csv = ["client,type,executive_1,rate_1,effective_from", "Beta,ACE,Albert,10,", "Beta,ACE,Jose,10.555,", "Beta,ACE,Jose,10,2025-13-01", "Beta,ACE,Jose,10,2025-02-30"].join("\n");
    const plan = await planImport(csv, { createMissingExecutives: true });
    expect(plan.ready).toEqual([]);
    expect(plan.problems.map((p) => p.error)).toEqual([
      expect.stringMatching(/Albert.*inactive/i),
      expect.stringMatching(/two decimal/i),
      expect.stringMatching(/real date/i),
      expect.stringMatching(/real date/i),
    ]);
    expect((await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_b" } })).type).toBe("DIRECT");
  });

  it("the same client twice in one file is a problem, not a silent overwrite", async () => {
    await db.client.create({ data: { name: "Beta", email: "b@x.co", stripeCustomerId: "cus_b" } });
    const plan = await planImport("client,executive_1,rate_1\nBeta,Jose,10\nb@x.co,Jose,5", { createMissingExecutives: false });
    expect(plan.ready).toHaveLength(1);
    expect(plan.problems[0].error).toMatch(/more than once/i);
  });

  it("effective dates are business-time-zone midnights, like the client page", async () => {
    await db.client.create({ data: { name: "Beta", stripeCustomerId: "cus_b" } });
    const plan = await planImport("client,executive_1,rate_1,effective_from\nBeta,Jose,10,2025-01-01", { createMissingExecutives: false });
    expect(plan.ready[0].effectiveFrom.toISOString()).toBe("2025-01-01T05:00:00.000Z");
  });
});

describe("#3 ACE rows respect autopay and historical batches", () => {
  async function batch(historical: boolean, note: string) {
    const b = await createBatch({ purchasedOn: "2026-09-01", note, lines: [{ packageId: growth, quantity: 2, unitPriceCents: 400000 }], alreadyPaid: { paidOn: "2026-09-02", method: "check", reference: "1" }, historical });
    if (!b.ok) throw new Error(b.error);
  }
  it("a client on Stripe autopay can only go into a historical batch; a non-historical batch shows the lump sum it will post", async () => {
    await batch(false, "Fall");
    await batch(true, "Old");
    await db.client.create({ data: { name: "Subbed", stripeCustomerId: "cus_s", stripeSubscriptionId: "sub_s", packageId: growth } });
    await db.client.create({ data: { name: "New Ace", stripeCustomerId: "cus_n", packageId: growth } });
    const plan = await planImport(
      ["client,type,executive_1,rate_1,ace_batch,ace_start_date", "Subbed,ACE,Jose,10,Fall,2026-10-10", "Subbed,ACE,Jose,10,Old,2026-10-10", "New Ace,ACE,Jose,10,Fall,2026-10-11"].join("\n"),
      { createMissingExecutives: false },
    );
    expect(plan.problems.map((p) => [p.line, p.error])).toEqual([[2, expect.stringMatching(/autopay/i)]]);
    expect(plan.ready.map((r) => [r.clientName, r.aceLumpSum])).toEqual([["Subbed", false], ["New Ace", true]]);
  });

  it("ACE months already earned are the paid months after the prepaid six (0–6)", async () => {
    await db.client.create({ data: { name: "Ace", stripeCustomerId: "cus_a", type: "ACE" } });
    const plan = await planImport("client,type,executive_1,rate_1,months_already_earned\nAce,ACE,Jose,10,9", { createMissingExecutives: false });
    expect(plan.problems[0].error).toMatch(/0 to 6/);
  });
});

describe("#4 no suspensions while client notices are off", () => {
  it("doesn't pause anyone in Stripe before launch", async () => {
    await db.setting.update({ where: { key: "launch" }, data: { value: { noticesOn: false, checks: {} } } });
    const c = await db.client.create({ data: { name: "Late", stripeCustomerId: "cus_l", stripeSubscriptionId: "sub_l" } });
    await db.invoice.create({ data: { stripeInvoiceId: "in_l", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: d("2026-09-01T12:00:00Z"), periodStart: d("2026-09-01T12:00:00Z"), periodEnd: d("2026-09-01T12:00:00Z") } });
    const update = vi.fn();
    expect(await runSuspensions(d("2026-11-20T12:00:00Z"), { subscriptions: { update } } as unknown as Stripe)).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("#5 a portal already sending notices keeps sending after this update", () => {
  it("the migration turns notices on when notices were already being sent, and leaves a new portal off", async () => {
    const dir = readdirSync("prisma/migrations").find((m) => m.endsWith("_launch_notices_default"));
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    await db.setting.deleteMany({ where: { key: "launch" } });
    await db.$executeRawUnsafe(sql);
    expect(await db.setting.findUnique({ where: { key: "launch" } })).toBeNull();
    await db.notification.create({ data: { key: "k", kind: "t", status: "SENT" } });
    await db.$executeRawUnsafe(sql);
    expect((await db.setting.findUniqueOrThrow({ where: { key: "launch" } })).value).toMatchObject({ noticesOn: true });
  });
});
