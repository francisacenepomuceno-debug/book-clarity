import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { applyImport, planImport } from "@/migration/commissionImport";
import { createBatch } from "@/ace/batches";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

let ess = "";
beforeEach(async () => {
  await resetDb();
  sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
  ess = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } })).id;
  await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } });
  const b = await createBatch({ purchasedOn: "2026-06-01", note: "Cohort 2 B", lines: [{ packageId: ess, quantity: 2, unitPriceCents: 245000 }], alreadyPaid: { paidOn: "2026-06-01", method: "check", reference: "1" }, historical: true });
  if (!b.ok) throw new Error(b.error);
});

const CSV = [
  "client,contact_email,phone,package,type,ace_batch,ace_start_date",
  "One Eleven Ventures,mistimoorevp@gmail.com,(404) 735-5493,Essentials,ACE,Cohort 2 B,2026-09-01",
  "Tarr Personal Care Home,admin@tarrpch.com,,Essentials,ACE,Cohort 2 B,2026-08-17",
].join("\n");

describe("import can add clients who aren't in the portal yet", () => {
  it("only when asked; then creates them as ACE clients in their batch slots", async () => {
    const off = await planImport(CSV, { createMissingExecutives: false });
    expect(off.ready).toEqual([]);
    expect(off.problems[0].error).toMatch(/No client matches/);

    const plan = await planImport(CSV, { createMissingExecutives: false, createMissingClients: true });
    expect(plan.problems).toEqual([]);
    expect(plan.ready.map((r) => [r.clientName, r.create?.email])).toEqual([["One Eleven Ventures", "mistimoorevp@gmail.com"], ["Tarr Personal Care Home", "admin@tarrpch.com"]]);
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 2, failed: [] });
    const c = await db.client.findFirstOrThrow({ where: { name: "One Eleven Ventures" } });
    expect(c).toMatchObject({ type: "ACE", email: "mistimoorevp@gmail.com", phone: "(404) 735-5493", packageId: ess });
    expect(c.aceSlotId).not.toBeNull();
    expect(c.acePrepaidUntil?.toLocaleDateString("en-CA", { timeZone: "America/New_York" })).toBe("2027-02-28");

    // Running it again finds them by name and changes nothing.
    const again = await planImport(CSV, { createMissingExecutives: false, createMissingClients: true });
    expect(again.ready.every((r) => !r.create)).toBe(true);
    await applyImport(again.ready);
    expect(await db.client.count()).toBe(2);
  });

  it("a new client needs a type and a known package", async () => {
    const plan = await planImport("client,package,type\nNo Type Co,Essentials,\nBad Pkg Co,Platinum,ACE", { createMissingExecutives: false, createMissingClients: true });
    expect(plan.problems.map((p) => p.error)).toEqual([expect.stringMatching(/type/i), expect.stringMatching(/package/i)]);
  });
});

describe("months already earned on their own (clients who came from ACE)", () => {
  it("are saved without an executive, keep the existing split, and re-running changes nothing", async () => {
    const t = await db.client.create({ data: { name: "Teresa Pajaro", email: "307tacoloco@gmail.com", stripeCustomerId: "cus_T", type: "DIRECT" } });
    const csv = "client,months_already_earned\ncus_T,6";
    const plan = await planImport(csv, { createMissingExecutives: false });
    expect(plan.problems).toEqual([]);
    expect(plan.ready[0]).toMatchObject({ clientName: "Teresa Pajaro", shares: [], monthsBeforePortal: 6, willPost: [] });
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 1, failed: [] });
    expect((await db.client.findUniqueOrThrow({ where: { id: t.id } })).commissionMonthsBeforePortal).toBe(6);
    expect((await db.client.findUniqueOrThrow({ where: { id: t.id } })).type).toBe("DIRECT");
    expect(await db.auditLog.count({ where: { action: "commission_months_set", entityId: t.id } })).toBe(1);
    await applyImport((await planImport(csv, { createMissingExecutives: false })).ready);
    expect(await db.auditLog.count({ where: { action: "commission_months_set", entityId: t.id } })).toBe(1);
  });

  it("are still range-checked", async () => {
    await db.client.create({ data: { name: "X", stripeCustomerId: "cus_X" } });
    expect((await planImport("client,months_already_earned\ncus_X,13", { createMissingExecutives: false })).problems[0].error).toMatch(/0 to 12/);
  });

  it("one contact with two companies becomes two clients", async () => {
    const two = ["client,company,contact_email,package,type,ace_batch,ace_start_date", "Pat Owner,Shop North,pat@x.co,Essentials,ACE,Cohort 2 B,2026-06-01", "Pat Owner,Shop South,pat@x.co,Essentials,ACE,Cohort 2 B,2026-06-03"].join("\n");
    const plan = await planImport(two, { createMissingExecutives: false, createMissingClients: true });
    expect(plan.problems).toEqual([]);
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 2, failed: [] });
    expect((await db.client.findMany({ orderBy: { companyName: "asc" } })).map((c) => [c.name, c.companyName, !!c.aceSlotId])).toEqual([["Pat Owner", "Shop North", true], ["Pat Owner", "Shop South", true]]);
    // Re-running matches each by contact + company.
    const again = await planImport(two, { createMissingExecutives: false, createMissingClients: true });
    expect(again.problems).toEqual([]);
    expect(again.ready.every((r) => !r.create)).toBe(true);
  });
});
