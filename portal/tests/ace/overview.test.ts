import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { aceSlotOverview } from "@/ace/overview";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "a", email: "a@x.co", name: "A", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

let essentials: string;
let growth: string;

async function batch(paid: boolean, slots: { packageId: string; clientId?: string; start?: string }[]) {
  const b = await db.aceBatch.create({ data: { purchasedAt: new Date("2026-10-01"), totalCents: 1, createdById: "u", paidAt: paid ? new Date("2026-10-02") : null } });
  for (const s of slots) {
    await db.aceSlot.create({
      data: {
        batchId: b.id,
        packageId: s.packageId,
        clientId: s.clientId ?? null,
        startDate: s.start ? new Date(s.start) : null,
        prepaidUntil: s.start ? new Date(new Date(s.start).getTime() + 180 * 86400_000) : null,
      },
    });
  }
  return b.id;
}

beforeEach(async () => {
  await resetDb();
  sessionRef.current = OWNER;
  essentials = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0 } })).id;
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } })).id;
});

describe("aceSlotOverview", () => {
  it("counts bought / used / available per package across batches, and which open slots are in unpaid batches", async () => {
    const a = (await db.client.create({ data: { name: "Alpha Co", type: "ACE", status: "PREPAID_ACE" } })).id;
    const b = (await db.client.create({ data: { name: "Beta Co", type: "ACE", status: "PREPAID_ACE" } })).id;
    await batch(true, [{ packageId: essentials, clientId: a, start: "2026-10-05" }, { packageId: essentials }, { packageId: growth, clientId: b, start: "2026-10-10" }]);
    await batch(false, [{ packageId: essentials }, { packageId: growth }]);

    const o = await aceSlotOverview();
    expect(o.byPackage).toEqual([
      { packageId: essentials, name: "Essentials", bought: 3, used: 1, available: 2, availableInUnpaidBatches: 1 },
      { packageId: growth, name: "Growth", bought: 2, used: 1, available: 1, availableInUnpaidBatches: 1 },
    ]);
    expect(o.assigned.map((s) => [s.clientName, s.packageName, s.status])).toEqual([
      ["Alpha Co", "Essentials", "PREPAID_ACE"],
      ["Beta Co", "Growth", "PREPAID_ACE"],
    ]);
    expect(o.assigned[0]).toMatchObject({ batchPaid: true, startDate: new Date("2026-10-05") });
  });

  it("filters the client list by package", async () => {
    const a = (await db.client.create({ data: { name: "Alpha Co", type: "ACE", status: "PREPAID_ACE" } })).id;
    const b = (await db.client.create({ data: { name: "Beta Co", type: "ACE", status: "PREPAID_ACE" } })).id;
    await batch(true, [{ packageId: essentials, clientId: a, start: "2026-10-05" }, { packageId: growth, clientId: b, start: "2026-10-10" }]);
    expect((await aceSlotOverview({ packageId: growth })).assigned.map((s) => s.clientName)).toEqual(["Beta Co"]);
  });

  it("Admins can't see it", async () => {
    sessionRef.current = ADMIN;
    await expect(aceSlotOverview()).rejects.toThrow(/Forbidden/);
  });
});
