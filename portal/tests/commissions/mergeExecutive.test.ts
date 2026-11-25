import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { mergeExecutive } from "@/commissions/splits";
import { findExecutive, planImport } from "@/migration/commissionImport";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "u1", email: "u@x.co", name: "U", role: "OWNER" } });
  as("OWNER");
});

describe("merging a duplicate executive", () => {
  it("moves splits, lines and statements to the other executive and removes the duplicate", async () => {
    const full = await db.executive.create({ data: { name: "Exec Fullname" } });
    const dup = await db.executive.create({ data: { name: "Exec" } });
    const c = await db.client.create({ data: { name: "Acme" } });
    await db.commissionShare.create({ data: { clientId: c.id, executiveId: dup.id, rateBp: 1000, effectiveFrom: new Date("2026-01-01"), createdById: "u1" } });
    const line = (exec: string, inv: string) => db.commissionEntry.create({ data: { executiveId: exec, clientId: c.id, invoiceId: inv, kind: "EARNED", windowIndex: 1, baseCents: 1000, rateBp: 1000, amountCents: 100, occurredAt: new Date("2026-11-05"), month: "2026-11" } });
    await line(dup.id, "inv_a");
    await line(dup.id, "inv_b");
    await line(full.id, "inv_b"); // already on the other one: kept once
    await db.commissionStatement.create({ data: { executiveId: dup.id, month: "2026-10", status: "PAID", paidAt: new Date("2026-11-01"), totalCents: 500 } });

    expect(await mergeExecutive(dup.id, full.id)).toEqual({ ok: true });
    expect(await db.executive.findMany()).toHaveLength(1);
    expect((await db.commissionShare.findFirstOrThrow()).executiveId).toBe(full.id);
    expect((await db.commissionEntry.findMany({ orderBy: { invoiceId: "asc" } })).map((e) => [e.executiveId, e.invoiceId])).toEqual([[full.id, "inv_a"], [full.id, "inv_b"]]);
    expect(await db.commissionStatement.findFirstOrThrow()).toMatchObject({ executiveId: full.id, month: "2026-10", status: "PAID" });
  });

  it("only Owners, and not into itself", async () => {
    const a = await db.executive.create({ data: { name: "A" } });
    const b = await db.executive.create({ data: { name: "B" } });
    expect((await mergeExecutive(a.id, a.id)).ok).toBe(false);
    as("ADMIN");
    expect((await mergeExecutive(a.id, b.id)).ok).toBe(false);
    expect(await db.executive.count()).toBe(2);
  });
});

describe("import: executive names", () => {
  it("a first name matches the one executive with that first name; ambiguous or unknown names don't", async () => {
    const execs = [{ name: "Albert Assad" }, { name: "Jose Cortes" }, { name: "Sam One" }, { name: "Sam Two" }];
    expect(findExecutive(execs, "albert")?.name).toBe("Albert Assad");
    expect(findExecutive(execs, "Jose Cortes")?.name).toBe("Jose Cortes");
    expect(findExecutive(execs, "Sam")).toBeUndefined();
    expect(findExecutive(execs, "Maria")).toBeUndefined();

    await db.executive.create({ data: { name: "Albert Assad" } });
    await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_a" } });
    const plan = await planImport("client,executive_1,rate_1\ncus_a,Albert,10%\n", { createMissingExecutives: true });
    expect(plan.ready[0].newExecutives).toEqual([]);
  });
});
