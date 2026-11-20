import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dashboardAlerts } from "@/reports/alerts";
import { resetDb } from "../helpers/db";

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const keys = async () => Object.fromEntries((await dashboardAlerts(now)).map((g) => [g.kind, g.items.map((i) => i.name)]));

beforeEach(resetDb);

describe("dashboard alerts", () => {
  it("each alert appears inside its threshold and not outside it", async () => {
    const mk = (name: string, o: Record<string, unknown> = {}) => db.client.create({ data: { name, ...o } });
    const recent = await mk("Declined recently", { stripeSubscriptionId: "sub_r" });
    const old = await mk("Declined long ago");
    const inv = (clientId: string, failed: Date) => db.invoice.create({ data: { stripeInvoiceId: `in_${clientId}`, clientId, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: failed, periodStart: failed, periodEnd: failed } });
    await inv(recent.id, ago(2));
    await inv(old.id, ago(8));
    await mk("At risk", { status: "AT_RISK" });
    await mk("On hold", { status: "SUSPENDED" });
    await mk("ACE soon", { type: "ACE", acePrepaidUntil: new Date(now.getTime() + 50 * DAY) });
    await mk("ACE later", { type: "ACE", acePrepaidUntil: new Date(now.getTime() + 70 * DAY) });
    await mk("ACE decided", { type: "ACE", acePrepaidUntil: new Date(now.getTime() + 50 * DAY), continuationDecision: "CONTINUING" });
    const b = await db.aceBatch.create({ data: { purchasedAt: ago(30), totalCents: 1, createdById: "u", note: "Fall batch" } });
    await db.aceSlot.create({ data: { batchId: b.id, packageId: "p" } });
    const full = await db.aceBatch.create({ data: { purchasedAt: ago(30), totalCents: 1, createdById: "u", note: "Full" } });
    const holder = await mk("Slot holder");
    await db.aceSlot.create({ data: { batchId: full.id, packageId: "p", clientId: holder.id } });
    const disc = await mk("Discount ending");
    await db.discount.create({ data: { clientId: disc.id, kind: "PERCENT", percentOff: 10, months: 3, reason: "r", stripeCouponId: "c", createdById: "u", createdAt: new Date("2026-09-01T12:00:00Z") } });
    const disc2 = await mk("Discount far");
    await db.discount.create({ data: { clientId: disc2.id, kind: "PERCENT", percentOff: 10, months: 6, reason: "r", stripeCouponId: "c2", createdById: "u", createdAt: new Date("2026-09-01T12:00:00Z") } });
    const stuck = await mk("Stuck onboarding");
    await db.onboarding.create({ data: { clientId: stuck.id, lastProgressAt: ago(4) } });
    const fresh = await mk("Fresh onboarding");
    await db.onboarding.create({ data: { clientId: fresh.id, lastProgressAt: ago(1) } });
    const sig = await mk("Needs countersign");
    await db.onboarding.create({ data: { clientId: sig.id, signedAt: ago(1), lastProgressAt: now } });

    expect(await keys()).toEqual({
      declines: ["Declined recently"],
      atRisk: ["At risk", "On hold"],
      aceMonth6: ["ACE soon"],
      openSlots: ["Fall batch"],
      discountsEnding: ["Discount ending"],
      stuckOnboarding: ["Stuck onboarding"],
      countersign: ["Needs countersign"],
    });
  });

  it("no alerts when all is well", async () => {
    expect(await dashboardAlerts(now)).toEqual([]);
  });
});
