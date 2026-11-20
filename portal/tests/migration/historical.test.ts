import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createBatch } from "@/ace/batches";
import { assignSlot, postAceCommissionsForBatch } from "@/ace/slots";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

beforeEach(async () => {
  await resetDb();
  sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
});

async function setup(historical: boolean) {
  const pkg = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } });
  const jose = await db.executive.create({ data: { name: "Jose" } });
  const c = await db.client.create({ data: { name: "Old ACE", type: "ACE", packageId: pkg.id } });
  await db.commissionShare.create({ data: { clientId: c.id, executiveId: jose.id, rateBp: 1000, effectiveFrom: new Date("2020-01-01"), createdById: "u" } });
  const r = await createBatch({ purchasedOn: "2026-03-01", lines: [{ packageId: pkg.id, quantity: 2, unitPriceCents: 400000 }], alreadyPaid: { paidOn: "2026-03-05", method: "check", reference: "1001" }, historical });
  if (!r.ok) throw new Error(r.error);
  return { batchId: r.batchId, clientId: c.id, packageId: pkg.id };
}

describe("historical ACE batches", () => {
  it("assigning a slot posts no months 1–6 commission, and neither does a later re-post", async () => {
    const { batchId, clientId, packageId } = await setup(true);
    const a = await assignSlot({ batchId, packageId, clientId, startOn: "2026-03-10" });
    expect(a.ok).toBe(true);
    await postAceCommissionsForBatch(batchId);
    expect(await db.commissionEntry.count()).toBe(0);
    expect((await db.aceBatch.findUniqueOrThrow({ where: { id: batchId } })).historical).toBe(true);
  });

  it("a historical batch must be marked already paid", async () => {
    const pkg = await db.package.create({ data: { name: "G2", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    const r = await createBatch({ purchasedOn: "2026-03-01", lines: [{ packageId: pkg.id, quantity: 1, unitPriceCents: 1 }], historical: true });
    expect(r.ok ? "" : r.error).toMatch(/already paid/i);
  });

  it("normal batches still post the lump sum", async () => {
    const { batchId, clientId, packageId } = await setup(false);
    await assignSlot({ batchId, packageId, clientId, startOn: "2026-03-10" });
    expect(await db.commissionEntry.count({ where: { kind: "ACE_PREPAID" } })).toBe(1);
  });
});
