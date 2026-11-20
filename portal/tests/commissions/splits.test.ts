import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addExecutive, setClientCommission, unassignedClients } from "@/commissions/splits";
import { startOfDayIn } from "@/domain/commission";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

const OWNER = { user: { id: "owner1", email: "o@x.co", name: "Owner", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "admin1", email: "a@x.co", name: "Alex", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

let clientId: string;
let jose: string;
let albert: string;

async function paid(paidAt: string, n: number) {
  return db.invoice.create({
    data: {
      stripeInvoiceId: `in_${n}`, clientId, status: "paid", kind: "SUBSCRIPTION",
      subtotalCents: 80000, totalCents: 80000, amountPaidCents: 80000, paidAt: new Date(paidAt),
      periodStart: new Date(paidAt), periodEnd: new Date(paidAt),
    },
  });
}

beforeEach(async () => {
  await resetDb();
  sessionRef.current = OWNER;
  clientId = (await db.client.create({ data: { name: "Acme", stripeCustomerId: "cus_1", status: "CURRENT" } })).id;
  jose = (await db.executive.create({ data: { name: "Jose" } })).id;
  albert = (await db.executive.create({ data: { name: "Albert" } })).id;
});

describe("addExecutive", () => {
  it("adds once, case-insensitively unique", async () => {
    expect((await addExecutive("Henry")).ok).toBe(true);
    expect((await addExecutive("  henry ")).ok).toBe(false);
  });
  it("Admins can't", async () => {
    sessionRef.current = ADMIN;
    expect(await addExecutive("Rochelle")).toEqual({ ok: false, error: "You don't have permission to do that." });
  });
});

describe("setClientCommission", () => {
  it("a payment recorded before the owner was assigned earns once the split is set (and only once)", async () => {
    await paid("2026-11-15T15:00:00Z", 1);
    const input = { shares: [{ executiveId: jose, ratePercent: 5 }, { executiveId: albert, ratePercent: 5 }], effectiveFrom: new Date("2026-11-01T05:00:00Z") };
    expect((await setClientCommission(clientId, input)).ok).toBe(true);
    expect(await db.commissionShare.count({ where: { clientId } })).toBe(2);
    expect((await db.commissionEntry.findMany()).map((e) => e.amountCents).sort()).toEqual([4000, 4000]);
    await setClientCommission(clientId, input);
    expect(await db.commissionEntry.count()).toBe(2);
    expect(await db.auditLog.count({ where: { action: "commission_split_set" } })).toBe(2);
  });

  it("a split change applies from its date forward", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-06-01T04:00:00Z") });
    await paid("2026-10-15T15:00:00Z", 1);
    await paid("2026-11-15T15:00:00Z", 2);
    await setClientCommission(clientId, { shares: [{ executiveId: albert, ratePercent: 10 }], effectiveFrom: new Date("2026-11-01T04:00:00Z") });
    const rows = await db.commissionEntry.findMany({ orderBy: { occurredAt: "asc" } });
    expect(rows.map((r) => r.executiveId)).toEqual([jose, albert]);
  });

  it("records months already earned before the portal", async () => {
    await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date("2026-01-01"), monthsBeforePortal: 4 });
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).commissionMonthsBeforePortal).toBe(4);
  });

  it.each([
    ["over 30% in total", [{ e: "jose", p: 20 }, { e: "albert", p: 15 }]],
    ["a fraction of a basis point", [{ e: "jose", p: 2.555 }]],
    ["an unknown executive", [{ e: "nobody", p: 10 }]],
  ])("rejects %s", async (_, list) => {
    const ids: Record<string, string> = { jose, albert, nobody: "exec_missing" };
    const r = await setClientCommission(clientId, { shares: list.map((x) => ({ executiveId: ids[x.e], ratePercent: x.p })), effectiveFrom: new Date() });
    expect(r.ok).toBe(false);
    expect(await db.commissionShare.count()).toBe(0);
  });

  it("rejects an inactive executive and months-before outside 0–12", async () => {
    await db.executive.update({ where: { id: albert }, data: { active: false } });
    expect((await setClientCommission(clientId, { shares: [{ executiveId: albert, ratePercent: 10 }], effectiveFrom: new Date() })).ok).toBe(false);
    expect((await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date(), monthsBeforePortal: 13 })).ok).toBe(false);
  });

  it("Admins can't", async () => {
    sessionRef.current = ADMIN;
    const r = await setClientCommission(clientId, { shares: [{ executiveId: jose, ratePercent: 10 }], effectiveFrom: new Date() });
    expect(r).toEqual({ ok: false, error: "You don't have permission to do that." });
    expect(await db.commissionShare.count()).toBe(0);
  });
});

describe("unassignedClients", () => {
  it("lists active clients with no commission owner", async () => {
    await db.client.create({ data: { name: "Gone", stripeCustomerId: "cus_2", status: "ENDED", endedAt: new Date() } });
    const assigned = await db.client.create({ data: { name: "Owned", stripeCustomerId: "cus_3", status: "CURRENT" } });
    await db.commissionShare.create({ data: { clientId: assigned.id, executiveId: jose, rateBp: 1000, effectiveFrom: new Date(), createdById: "x" } });
    expect((await unassignedClients()).map((c) => c.name)).toEqual(["Acme"]);
  });
});

describe("startOfDayIn", () => {
  it("is midnight in the business timezone", () => {
    expect(startOfDayIn("2026-11-01", "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfDayIn("2026-01-15", "America/New_York").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});
