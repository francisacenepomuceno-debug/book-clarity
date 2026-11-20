import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { countersign, executedText } from "@/onboarding/countersign";
import { runOnboardingReminders } from "@/onboarding/reminders";
import { getOnboardingSettings, saveOnboardingSettings } from "@/settings/onboarding";
import { runDaily } from "@/notify/daily";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (id: string, role: string, name = "Jose Owner") => (sessionRef.current = { user: { id, email: `${id}@x.co`, name, role, totpEnabled: true }, twoFactorVerified: true });

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");
const SIGNED = "Terms...\nSigned electronically by Jane Doe on November 20, 2026\nAwaiting countersignature by Book Clarity, LLC\n";

async function signed(over: Record<string, unknown> = {}) {
  const c = await db.client.create({ data: { name: "Acme LLC", email: "a@acme.co" } });
  return db.onboarding.create({ data: { clientId: c.id, packageId: "p", details: {}, signedAt: now, signerName: "Jane Doe", signedText: SIGNED, ...over } });
}

beforeEach(async () => {
  await resetDb();
  ghl.upsert.mockReset().mockResolvedValue("ct");
  ghl.send.mockReset().mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("countersigning", () => {
  it("Owners countersign once and the client is emailed the executed copy once", async () => {
    const o = await signed();
    as("jose", "OWNER");
    expect(await countersign(o.id, now)).toEqual({ ok: true });
    expect((await countersign(o.id, now)).ok).toBe(false);
    const row = await db.onboarding.findUniqueOrThrow({ where: { id: o.id } });
    expect(row).toMatchObject({ countersignedById: "jose", countersignedAt: now });
    expect(row.signedText).toBe(SIGNED); // the client's signed copy is never rewritten
    const notes = await db.notification.findMany();
    expect(notes.map((n) => n.key)).toEqual([`contract-executed:${o.id}`]);
    const html = (ghl.send.mock.calls[0][0] as { html: string }).html;
    expect(html).toMatch(/Signed electronically by Jose Owner for Book Clarity, LLC/);
  });
  it("Admins can't countersign", async () => {
    const o = await signed();
    as("al", "ADMIN");
    expect((await countersign(o.id, now)).ok).toBe(false);
  });
  it("the executed copy replaces only the countersignature line", () => {
    expect(executedText(SIGNED, "Jose", "Nov 21")).toBe("Terms...\nSigned electronically by Jane Doe on November 20, 2026\nSigned electronically by Jose for Book Clarity, LLC on Nov 21\n");
  });
});

describe("onboarding settings", () => {
  it("validates and saves (Owners)", async () => {
    as("jose", "OWNER");
    expect((await saveOnboardingSettings({ intakeQuestions: "A\nB | long", countersignerUserId: "", calendarUrl: "http://x", suspendAfterDays: 30 })).ok).toBe(false);
    expect((await saveOnboardingSettings({ intakeQuestions: "A", countersignerUserId: "", calendarUrl: "", suspendAfterDays: 3 })).ok).toBe(false);
    expect((await saveOnboardingSettings({ intakeQuestions: "A\nB | long", countersignerUserId: "", calendarUrl: "https://cal.test/x", suspendAfterDays: 45 })).ok).toBe(true);
    expect(await getOnboardingSettings()).toMatchObject({ calendarUrl: "https://cal.test/x", suspendAfterDays: 45 });
    as("al", "ADMIN");
    expect((await saveOnboardingSettings({ intakeQuestions: "A", countersignerUserId: "", calendarUrl: "", suspendAfterDays: 30 })).ok).toBe(false);
  });
});

describe("onboarding reminders", () => {
  it("nudges a stuck client once per step, and reminds the countersigner after 2 days", async () => {
    await db.user.create({ data: { id: "jose", email: "jose@bc.test", name: "Jose", role: "OWNER" } });
    const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co" } });
    const o = await db.onboarding.create({ data: { clientId: c.id, lastProgressAt: new Date(now.getTime() - 4 * DAY) } });
    const s = await signed({ signedAt: new Date(now.getTime() - 3 * DAY), lastProgressAt: now, feePaidAt: now, intakeAt: now });
    await runOnboardingReminders(now);
    await runOnboardingReminders(now);
    const keys = (await db.notification.findMany()).map((n) => n.key).sort();
    expect(keys).toEqual([`countersign-reminder:${s.id}:jose`, `onboarding-nudge:${o.id}:package`].sort());
    // progress to a new step that also stalls → a new nudge
    await db.onboarding.update({ where: { id: o.id }, data: { packageId: "p", lastProgressAt: new Date(now.getTime() - 4 * DAY) } });
    await runOnboardingReminders(now);
    expect((await db.notification.findMany()).map((n) => n.key)).toContain(`onboarding-nudge:${o.id}:details`);
  });
  it("leaves fresh, finished and ended onboardings alone, and runs daily", async () => {
    const c = await db.client.create({ data: { name: "A", email: "a@x.co" } });
    await db.onboarding.create({ data: { clientId: c.id, lastProgressAt: new Date(now.getTime() - DAY) } });
    const c2 = await db.client.create({ data: { name: "B", email: "b@x.co", endedAt: now } });
    await db.onboarding.create({ data: { clientId: c2.id, lastProgressAt: new Date(now.getTime() - 9 * DAY) } });
    const c3 = await db.client.create({ data: { name: "C", email: "c@x.co" } });
    await db.onboarding.create({ data: { clientId: c3.id, completedAt: now, lastProgressAt: new Date(now.getTime() - 9 * DAY) } });
    const r = await runDaily(now);
    expect(r.onboarding).toEqual({ nudges: 0, countersignReminders: 0 });
    expect(await db.notification.count()).toBe(0);
  });
});
