import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { onboardingLink } from "@/onboarding/start";
import { pickCall, syncOnboardingCalls } from "@/onboarding/callSync";
import { confirmCallBooked } from "@/onboarding/steps";
import { saveOnboardingSettings, getOnboardingSettings, DEFAULT_INTAKE_QUESTIONS } from "@/settings/onboarding";
import type { GhlCalendarEvent } from "@/ghl/client";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn(), events: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, ghlCalendarEvents: ghl.events, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

const now = new Date("2026-11-24T15:00:00Z");
const CAL = "cal8Vg4abcdEFGH";
const ev = (o: Partial<GhlCalendarEvent>): GhlCalendarEvent => ({ id: "ev1", contactId: "ct_1", calendarId: CAL, startTime: "2026-12-02T15:00:00Z", appointmentStatus: "confirmed", ...o });

async function onboardingAt(step: "call" | "intake") {
  const pkg = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 0 } });
  const c = await db.client.create({ data: { name: "Acme LLC", email: "jane@acme.co", type: "DIRECT", packageId: pkg.id } });
  const o = await db.onboarding.create({
    data: { clientId: c.id, packageId: pkg.id, details: {}, signedAt: now, feePaidAt: now, intakeAt: step === "call" ? now : null },
  });
  return { o, c };
}

beforeEach(async () => {
  await resetDb();
  ghl.upsert.mockReset().mockResolvedValue("ct_1");
  ghl.events.mockReset().mockResolvedValue([]);
  await db.setting.create({ data: { key: "onboarding", value: { ghlCalendarId: CAL } } });
});

describe("pickCall", () => {
  it("prefers the soonest booked appointment, else shows the latest cancellation, and ignores other contacts", () => {
    const events = [
      ev({ id: "late", startTime: "2026-12-09T15:00:00Z" }),
      ev({ id: "soon", startTime: "2026-12-02T15:00:00Z" }),
      ev({ id: "x", contactId: "ct_other", startTime: "2026-11-30T15:00:00Z" }),
    ];
    expect(pickCall(events, "ct_1")?.eventId).toBe("soon");
    expect(pickCall([ev({ appointmentStatus: "cancelled" })], "ct_1")).toMatchObject({ eventId: "ev1", cancelled: true });
    expect(pickCall([ev({ deleted: true })], "ct_1")).toBeNull();
    expect(pickCall(events, "ct_none")).toBeNull();
  });
});

describe("syncOnboardingCalls", () => {
  it("a booked call on the GHL calendar finishes onboarding and records its time", async () => {
    const { o, c } = await onboardingAt("call");
    ghl.events.mockResolvedValue([ev({})]);
    expect(await syncOnboardingCalls({ now })).toMatchObject({ checked: 1, booked: 1, completed: 1 });
    expect(await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      callStartsAt: new Date("2026-12-02T15:00:00Z"), callStatus: "booked", callEventId: "ev1", callBookedAt: now, completedAt: now,
    });
    // The client's GHL contact (matched by email) is remembered for messages too.
    expect(ghl.upsert).toHaveBeenCalledWith({ email: "jane@acme.co", phone: null });
    expect((await db.client.findUniqueOrThrow({ where: { id: c.id } })).ghlContactId).toBe("ct_1");
    expect(ghl.events.mock.calls[0][0]).toBe(CAL);
  });

  it("a call booked before the last step is recorded but doesn't skip the questionnaire", async () => {
    const { o } = await onboardingAt("intake");
    ghl.events.mockResolvedValue([ev({})]);
    await syncOnboardingCalls({ now });
    expect(await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ callStatus: "booked", callBookedAt: null, completedAt: null });
  });

  it("picks up a reschedule and a cancellation after onboarding is done", async () => {
    const { o } = await onboardingAt("call");
    ghl.events.mockResolvedValue([ev({})]);
    await syncOnboardingCalls({ now });
    ghl.events.mockResolvedValue([ev({ startTime: "2026-12-04T18:30:00Z" })]);
    await syncOnboardingCalls({ now });
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).callStartsAt).toEqual(new Date("2026-12-04T18:30:00Z"));
    ghl.events.mockResolvedValue([ev({ appointmentStatus: "cancelled", startTime: "2026-12-04T18:30:00Z" })]);
    expect((await syncOnboardingCalls({ now })).cancelled).toBe(1);
    // Removed from the calendar entirely counts as cancelled too.
    await db.onboarding.update({ where: { id: o.id }, data: { callStatus: "booked" } });
    ghl.events.mockResolvedValue([]);
    await syncOnboardingCalls({ now });
    expect(await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ callStatus: "cancelled", completedAt: now });
  });

  it("does nothing without a calendar ID", async () => {
    await db.setting.deleteMany();
    await onboardingAt("call");
    expect((await syncOnboardingCalls({ now })).skipped).toMatch(/calendar ID/);
    expect(ghl.events).not.toHaveBeenCalled();
  });
});

describe("I've booked my call", () => {
  it("uses the GHL booking when it's there, and the client's word when GHL is down or doesn't show it yet", async () => {
    const { o } = await onboardingAt("call");
    const token = onboardingLink(o.id, "https://p").split("/onboard/")[1];
    ghl.events.mockRejectedValue(new Error("GHL 503"));
    expect(await confirmCallBooked(token, now)).toEqual({ ok: true });
    expect(await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ completedAt: now, callStatus: null });

    await resetDb();
    await db.setting.create({ data: { key: "onboarding", value: { ghlCalendarId: CAL } } });
    const b = await onboardingAt("call");
    ghl.events.mockReset().mockResolvedValue([ev({})]);
    expect(await confirmCallBooked(onboardingLink(b.o.id, "https://p").split("/onboard/")[1], now)).toEqual({ ok: true });
    expect(await db.onboarding.findUniqueOrThrow({ where: { id: b.o.id } })).toMatchObject({ completedAt: now, callStatus: "booked" });
  });
});

describe("settings", () => {
  it("saves the calendar ID and rejects a link pasted in its place", async () => {
    await db.user.create({ data: { id: "u1", email: "o@bc.test", name: "O", role: "OWNER" } });
    sessionRef.current = { user: { id: "u1", email: "o@bc.test", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
    const base = { intakeQuestions: DEFAULT_INTAKE_QUESTIONS, countersignerUserId: "", calendarUrl: "", suspendAfterDays: 30 };
    expect((await saveOnboardingSettings({ ...base, ghlCalendarId: "https://api.leadconnectorhq.com/widget/booking/abc" })).ok).toBe(false);
    expect(await saveOnboardingSettings({ ...base, ghlCalendarId: "9Vg4newCalendarId" })).toEqual({ ok: true });
    expect((await getOnboardingSettings()).ghlCalendarId).toBe("9Vg4newCalendarId");
    // Saving the form without the field (older form) keeps it.
    expect(await saveOnboardingSettings(base)).toEqual({ ok: true });
    expect((await getOnboardingSettings()).ghlCalendarId).toBe("9Vg4newCalendarId");
  });
});
