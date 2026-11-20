import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { launchStatus, setCardFee, setManualCheck, setNoticesOn } from "@/settings/launch";
import { sendNotice } from "@/notify/send";
import { runDaily } from "@/notify/daily";
import { getFeeSettings } from "@/settings/cardFee";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ configured: true, upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => ghl.configured, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "sa", email: "sa@x.co", name: "SA", role, totpEnabled: true }, twoFactorVerified: true });

const DAY = 86400_000;
const now = new Date("2026-11-20T15:00:00Z");

beforeEach(async () => {
  await resetDb();
  await db.setting.deleteMany({ where: { key: "launch" } }); // start from the real default: notices off
  as("SUPER_ADMIN");
  ghl.configured = true;
  ghl.upsert.mockReset().mockResolvedValue("ct");
  ghl.send.mockReset().mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("notices stay off until launch", () => {
  it("every send is skipped while off, including the daily run", async () => {
    expect(await sendNotice({ key: "k1", kind: "t", to: { name: "A", email: "a@x.co" }, email: { subject: "s", html: "h" } })).toBe("SKIPPED");
    expect((await db.notification.findUniqueOrThrow({ where: { key: "k1" } })).error).toMatch(/turned on/i);
    const c = await db.client.create({ data: { name: "Late", email: "l@x.co", stripeSubscriptionId: "sub_1" } });
    await db.invoice.create({ data: { stripeInvoiceId: "in_1", clientId: c.id, status: "open", kind: "SUBSCRIPTION", subtotalCents: 1, totalCents: 1, firstFailedAt: new Date(now.getTime() - 3 * DAY), periodStart: now, periodEnd: now } });
    await runDaily(now);
    expect(ghl.send).not.toHaveBeenCalled();
  });

  it("can be turned on only when ACE start dates, GHL, the base URL and Stripe's own reminders are sorted", async () => {
    const ace = await db.client.create({ data: { name: "Ace", type: "ACE" } });
    let r = await setNoticesOn(true);
    expect(r.ok ? "" : r.error).toMatch(/ACE client/);
    await db.client.update({ where: { id: ace.id }, data: { endedAt: now } }); // ended ACE clients don't block
    r = await setNoticesOn(true);
    expect(r.ok ? "" : r.error).toMatch(/Stripe's own reminder emails/);
    await setManualCheck("stripeRemindersOff", true);
    ghl.configured = false;
    r = await setNoticesOn(true);
    expect(r.ok ? "" : r.error).toMatch(/GHL/);
    ghl.configured = true;
    expect(await setNoticesOn(true)).toEqual({ ok: true });
    expect(await sendNotice({ key: "k2", kind: "t", to: { name: "A", email: "a@x.co" }, email: { subject: "s", html: "h" } })).toBe("SENT");
    expect(await setNoticesOn(false)).toEqual({ ok: true });
  });

  it("only the Super Admin can use the launch switches", async () => {
    as("OWNER");
    expect((await setNoticesOn(true)).ok).toBe(false);
    expect((await setManualCheck("stripeRemindersOff", true)).ok).toBe(false);
    expect((await setCardFee({ enabled: false, ratePercent: 3, excludedStates: [] })).ok).toBe(false);
  });
});

describe("card fee switch", () => {
  it("needs ACE start dates, surcharge registration and client notice; then writes the fee settings", async () => {
    let r = await setCardFee({ enabled: true, ratePercent: 3, excludedStates: ["ct", "ma"] });
    expect(r.ok ? "" : r.error).toMatch(/surcharge/i);
    await setManualCheck("surchargeConfirmed", true);
    r = await setCardFee({ enabled: true, ratePercent: 3, excludedStates: [] });
    expect(r.ok ? "" : r.error).toMatch(/notice/i);
    await setManualCheck("clientsNotified", true);
    expect((await setCardFee({ enabled: true, ratePercent: 3.5, excludedStates: [] })).ok).toBe(false);
    expect((await setCardFee({ enabled: true, ratePercent: 3, excludedStates: ["Connecticut"] })).ok).toBe(false);
    expect(await setCardFee({ enabled: true, ratePercent: 3, excludedStates: ["ct", "ma"] })).toEqual({ ok: true });
    expect(await getFeeSettings()).toEqual({ enabled: true, rateBasisPoints: 300, excludedStates: ["CT", "MA"] });
    expect(await setCardFee({ enabled: false, ratePercent: 3, excludedStates: [] })).toEqual({ ok: true });
  });
});

describe("launch status", () => {
  it("reports automatic checks and who ticked the manual ones", async () => {
    await db.package.create({ data: { name: "Growth", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    await db.client.create({ data: { name: "No package" } });
    await setManualCheck("historyLoaded", true);
    const s = await launchStatus(now);
    const auto = Object.fromEntries(s.automatic.map((a) => [a.key, a.ok]));
    expect(auto).toMatchObject({ packagesPriced: false, clientsHavePackages: false, aceStartDates: true, ghl: true, baseUrl: true });
    expect(s.manual.find((m) => m.key === "historyLoaded")).toMatchObject({ done: true, by: "SA" });
    expect(s.noticesOn).toBe(false);
  });
});
