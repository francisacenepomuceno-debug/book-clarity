import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { applyImport, parseCsv, planImport, IMPORT_TEMPLATE } from "@/migration/commissionImport";
import { createBatch } from "@/ace/batches";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role, totpEnabled: true }, twoFactorVerified: true });

let growth = "";
beforeEach(async () => {
  await resetDb();
  as("OWNER");
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } })).id;
  await db.executive.create({ data: { name: "Jose" } });
  await db.executive.create({ data: { name: "Albert" } });
  await db.client.create({ data: { name: "Acme LLC", email: "ops@acme.co", stripeCustomerId: "cus_acme", packageId: growth } });
  await db.client.create({ data: { name: "Beta Co", email: "b@beta.co", stripeCustomerId: "cus_beta", packageId: growth } });
  await db.client.create({ data: { name: "Twin", email: "t1@x.co", stripeCustomerId: "cus_t1" } });
  await db.client.create({ data: { name: "twin", email: "t2@x.co", stripeCustomerId: "cus_t2" } });
});

describe("CSV parsing", () => {
  it("handles quotes, commas, CRLF and header aliases; the template parses", () => {
    const rows = parseCsv('Client Name,Owner,Commission %\r\n"Acme, LLC",Jose,10%\r\n');
    expect(rows).toEqual([{ client: "Acme, LLC", executive_1: "Jose", rate_1: "10%" }]);
    expect(parseCsv(IMPORT_TEMPLATE).length).toBeGreaterThan(0);
  });
});

describe("planning an import", () => {
  it("matches by customer id, email, then name; reports unmatched, ambiguous and invalid rows", async () => {
    const csv = [
      "client,type,executive_1,rate_1,executive_2,rate_2,months_already_earned",
      "cus_acme,Direct,Jose,5%,Albert,5,3",
      "B@BETA.CO,direct,Jose,10,,,0",
      "Nobody Inc,Direct,Jose,10,,,0",
      "Twin,Direct,Jose,10,,,0",
      "Acme LLC,Direct,Jose,20,Albert,15,0",
      "Acme LLC,Direct,Mystery,10,,,0",
      "Acme LLC,Direct,Jose,10,,,13",
      "Acme LLC,Weird,Jose,10,,,0",
    ].join("\n");
    const plan = await planImport(csv, { createMissingExecutives: false });
    expect(plan.ready.map((r) => [r.line, r.clientName, r.shares.map((s) => s.ratePercent)])).toEqual([
      [2, "Acme LLC", [5, 5]],
      [3, "Beta Co", [10]],
    ]);
    expect(plan.problems.map((p) => [p.line, p.error])).toEqual([
      [4, expect.stringMatching(/no client matches/i)],
      [5, expect.stringMatching(/more than one client/i)],
      [6, expect.stringMatching(/30%/)],
      [7, expect.stringMatching(/Mystery/)],
      [8, expect.stringMatching(/0 to 12/)],
      [9, expect.stringMatching(/Direct or ACE/)],
    ]);
  });

  it("can create missing executives when asked", async () => {
    const plan = await planImport("client,executive_1,rate_1\nAcme LLC,Henry Exec,10", { createMissingExecutives: true });
    expect(plan.problems).toEqual([]);
    expect(plan.ready[0].newExecutives).toEqual(["Henry Exec"]);
  });
});

describe("applying an import", () => {
  it("sets type, split and months already earned, and re-applying changes nothing", async () => {
    const csv = "client,type,executive_1,rate_1,executive_2,rate_2,months_already_earned,effective_from\ncus_acme,Direct,Jose,5,Albert,5,4,2025-01-01";
    const run = async () => applyImport((await planImport(csv, { createMissingExecutives: false })).ready);
    expect(await run()).toMatchObject({ applied: 1, failed: [] });
    await run();
    const c = await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_acme" } });
    expect(c).toMatchObject({ type: "DIRECT", commissionMonthsBeforePortal: 4 });
    const shares = await db.commissionShare.findMany({ where: { clientId: c.id } });
    expect(shares.map((s) => s.rateBp).sort()).toEqual([500, 500]);
    expect(shares.every((s) => s.effectiveFrom.toISOString().startsWith("2025-01-01"))).toBe(true);
  });

  it("puts an ACE client into a free slot of a named historical batch with their start date", async () => {
    const b = await createBatch({ purchasedOn: "2026-03-01", note: "Spring 2026", lines: [{ packageId: growth, quantity: 1, unitPriceCents: 400000 }], alreadyPaid: { paidOn: "2026-03-05", method: "check", reference: "1" }, historical: true });
    if (!b.ok) throw new Error(b.error);
    const csv = "client,type,executive_1,rate_1,months_already_earned,ace_batch,ace_start_date\nBeta Co,ACE,Jose,10,0,spring 2026,2026-03-10\nAcme LLC,ACE,Jose,10,0,Spring 2026,2026-03-11";
    const plan = await planImport(csv, { createMissingExecutives: false });
    // Only one free Growth slot: the second ACE row is a problem at planning time.
    expect(plan.ready.map((r) => r.clientName)).toEqual(["Beta Co"]);
    expect(plan.problems[0].error).toMatch(/no free Growth slot/i);
    expect(await applyImport(plan.ready)).toMatchObject({ applied: 1, failed: [] });
    const beta = await db.client.findUniqueOrThrow({ where: { stripeCustomerId: "cus_beta" } });
    expect(beta.type).toBe("ACE");
    expect(beta.aceSlotId).not.toBeNull();
    expect(await db.commissionEntry.count({ where: { kind: "ACE_PREPAID" } })).toBe(0); // historical
  });

  it("Admins can't import", async () => {
    as("ADMIN");
    await expect(planImport("client\nAcme LLC", { createMissingExecutives: false })).rejects.toThrow(/Forbidden/);
  });
});
