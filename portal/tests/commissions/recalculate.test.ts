import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { applyImport, planImport } from "@/migration/commissionImport";
import { markStatementPaid } from "@/commissions/statements";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "sa", email: "sa@x.co", name: "SA", role: "SUPER_ADMIN" } });
  sessionRef.current = { user: { id: "sa", email: "sa@x.co", name: "SA", role: "SUPER_ADMIN", totpEnabled: true }, twoFactorVerified: true };
  await db.executive.create({ data: { name: "Exec Full" } });
});

const paid = (clientId: string, id: string, at: string) =>
  db.invoice.create({ data: { stripeInvoiceId: id, clientId, stripeSubscriptionId: "sub_a", status: "paid", kind: "SUBSCRIPTION", subtotalCents: 95000, totalCents: 95000, amountPaidCents: 95000, paidAt: new Date(at), periodStart: new Date(at), periodEnd: new Date(at) } });
const run = async (csv: string, settled = "2026-11-01") => applyImport((await planImport(csv, { createMissingExecutives: false, settledThrough: settled })).ready);

describe("re-importing a corrected file", () => {
  it("redoes lines in unpaid months with the new months; a window that's over posts nothing", async () => {
    const c = await db.client.create({ data: { name: "Pat", companyName: "Acme", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a" } });
    await paid(c.id, "in_nov", "2026-11-19T15:00:00Z");
    await run("client,executive_1,rate_1,months_already_earned\ncus_a,Exec,10%,0\n");
    expect((await db.commissionEntry.findMany()).map((e) => e.windowIndex)).toEqual([1]);
    await run("client,executive_1,rate_1,months_already_earned\ncus_a,Exec,10%,10\n");
    expect((await db.commissionEntry.findMany()).map((e) => [e.windowIndex, e.amountCents])).toEqual([[11, 9500]]);
    await run("client,executive_1,rate_1,months_already_earned\ncus_a,Exec,10%,12\n");
    expect(await db.commissionEntry.count()).toBe(0);
  });

  it("never touches a month that's been paid", async () => {
    const c = await db.client.create({ data: { name: "Pat", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a" } });
    await paid(c.id, "in_oct", "2026-10-19T15:00:00Z");
    await run("client,executive_1,rate_1,months_already_earned\ncus_a,Exec,10%,0\n", "2026-10-01");
    const exec = await db.executive.findFirstOrThrow();
    expect((await markStatementPaid(exec.id, "2026-10", new Date("2026-11-02"))).ok).toBe(true);
    await run("client,executive_1,rate_1,months_already_earned\ncus_a,Exec,10%,12\n", "2026-10-01");
    expect((await db.commissionEntry.findMany()).map((e) => [e.month, e.windowIndex])).toEqual([["2026-10", 1]]);
  });
});
