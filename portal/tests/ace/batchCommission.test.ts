import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { assignSlot } from "@/ace/slots";
import { createBatch, recordBatchPayment } from "@/ace/batches";
import { monthlyBreakdown } from "@/commissions/breakdown";
import { statementLines } from "@/commissions/statements";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
vi.mock("@/stripe/client", () => ({ getStripe: () => ({ invoices: { pay: vi.fn(async () => ({})) } }) }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };

let ess: string;
let growth: string;
let exec: string;

beforeEach(async () => {
  await resetDb();
  sessionRef.current = OWNER;
  ess = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 35000 } })).id;
  growth = (await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 65000 } })).id;
  exec = (await db.executive.create({ data: { name: "Exec A" } })).id;
});

const lines = () => [
  { packageId: ess, quantity: 2, unitPriceCents: 245000 },
  { packageId: growth, quantity: 2, unitPriceCents: 455000 },
];

describe("commission on the whole ACE purchase", () => {
  it("pays the executive on every slot ACE paid for, less onboarding, in the month ACE paid, used or not", async () => {
    const r = await createBatch({
      purchasedOn: "2026-09-01",
      note: "Cohort X",
      lines: lines(),
      alreadyPaid: { paidOn: "2026-11-01", method: "check", reference: "" },
      commission: { executiveId: exec, rateBp: 1000 },
    });
    expect(r.ok).toBe(true);
    const entries = await db.commissionEntry.findMany({ where: { executiveId: exec } });
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.month === "2026-11" && e.kind === "ACE_PREPAID")).toBe(true);
    // 10% of (2 × $2,100) + 10% of (2 × $3,900) = $1,200
    expect(entries.reduce((n, e) => n + e.amountCents, 0)).toBe(120000);

    // Placing a client relabels that slot's line; no second line is posted.
    const batchId = (r as { batchId: string }).batchId;
    const c = await db.client.create({ data: { name: "Placed Co", status: "ONBOARDING" } });
    expect((await assignSlot({ batchId, packageId: ess, clientId: c.id, startOn: "2026-09-25" })).ok).toBe(true);
    const after = await db.commissionEntry.findMany({ where: { executiveId: exec } });
    expect(after).toHaveLength(4);
    expect(after.filter((e) => e.clientId === c.id)).toHaveLength(1);

    const lines2 = await statementLines(exec, "2026-11");
    expect(lines2.map((l) => l.clientName).sort()).toEqual(["Cohort X: open Essentials slot", "Cohort X: open Growth slot", "Cohort X: open Growth slot", "Placed Co"]);
    const [b] = await monthlyBreakdown("2026-11", new Date("2026-12-15T12:00:00Z"));
    expect(b.totalCents).toBe(120000);
  });

  it("posts when ACE's payment is recorded, not before; a historical batch can't carry a commission executive", async () => {
    const r = await createBatch({ purchasedOn: "2026-10-29", lines: lines(), alreadyPaid: { paidOn: "2026-11-02", method: "check", reference: "" }, commission: { executiveId: exec, rateBp: 1000 } });
    const batchId = (r as { batchId: string }).batchId;
    await db.commissionEntry.deleteMany();
    await db.aceBatch.update({ where: { id: batchId }, data: { paidAt: null, paidVia: null } });
    expect((await recordBatchPayment(batchId, { paidOn: "2026-11-20", method: "check", reference: "" })).ok).toBe(true);
    expect(await db.commissionEntry.count({ where: { executiveId: exec, month: "2026-11" } })).toBe(4);

    const h = await createBatch({ purchasedOn: "2026-03-30", lines: lines(), alreadyPaid: { paidOn: "2026-04-01", method: "check", reference: "" }, historical: true, commission: { executiveId: exec, rateBp: 1000 } });
    expect(h.ok).toBe(false);
  });
});

describe("deleting a batch entered by mistake", () => {
  it("removes it with its commission while its slots are open; refuses once a client is in a slot", async () => {
    const { deleteBatch } = await import("@/ace/batches");
    const r = await createBatch({ purchasedOn: "2026-10-29", note: "Wrong", lines: lines(), alreadyPaid: { paidOn: "2026-11-01", method: "check", reference: "" }, commission: { executiveId: exec, rateBp: 1000 } });
    const id = (r as { batchId: string }).batchId;
    expect(await db.commissionEntry.count()).toBe(4);
    expect(await deleteBatch(id)).toEqual({ ok: true });
    expect(await db.aceBatch.count()).toBe(0);
    expect(await db.aceSlot.count()).toBe(0);
    expect(await db.commissionEntry.count()).toBe(0);

    const r2 = await createBatch({ purchasedOn: "2026-10-29", lines: lines(), alreadyPaid: { paidOn: "2026-11-01", method: "check", reference: "" } });
    const id2 = (r2 as { batchId: string }).batchId;
    const c = await db.client.create({ data: { name: "In Slot Co", status: "ONBOARDING" } });
    await assignSlot({ batchId: id2, packageId: ess, clientId: c.id, startOn: "2026-10-01" });
    expect((await deleteBatch(id2)).ok).toBe(false);
  });
});
