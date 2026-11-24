import { db } from "@/lib/db";
import { ghlCalendarEvents, ghlConfigured, ghlUpsertContact, type GhlCalendarEvent } from "@/ghl/client";
import { getOnboardingSettings } from "@/settings/onboarding";
import { nextStep } from "@/domain/onboarding";

const DAY = 86400_000;
const CANCELLED = new Set(["cancelled", "canceled", "invalid"]);

export type CallSeen = { eventId: string; startsAt: Date; cancelled: boolean };

/**
 * Pure: the client's onboarding call among the calendar's appointments. A booked (not cancelled) appointment wins,
 * the soonest one if there are several; otherwise their latest cancelled one, so a cancellation is shown.
 */
export function pickCall(events: GhlCalendarEvent[], contactId: string): CallSeen | null {
  const mine = events
    .filter((e) => e.contactId === contactId && !e.deleted)
    .map((e) => ({ eventId: e.id, startsAt: new Date(e.startTime), cancelled: CANCELLED.has((e.appointmentStatus ?? "").toLowerCase()) }))
    .filter((e) => !Number.isNaN(e.startsAt.getTime()));
  const booked = mine.filter((e) => !e.cancelled).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (booked.length) return booked[0];
  const cancelled = mine.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  return cancelled[0] ?? null;
}

type Deps = {
  events?: (calendarId: string, from: Date, to: Date) => Promise<GhlCalendarEvent[]>;
  upsertContact?: typeof ghlUpsertContact;
};

/**
 * Checks Book Clarity's GHL onboarding calendar for new clients' calls and records the time. A client on the
 * last step whose call is booked finishes onboarding; reschedules and cancellations are picked up later
 * (daily, and whenever the client opens their onboarding page). Does nothing until GHL and the calendar ID are set.
 */
export async function syncOnboardingCalls(
  opts: { onboardingIds?: string[]; now?: Date } = {},
  deps: Deps = {},
): Promise<{ checked: number; booked: number; completed: number; cancelled: number; skipped?: string }> {
  const now = opts.now ?? new Date();
  const result = { checked: 0, booked: 0, completed: 0, cancelled: 0 };
  const { ghlCalendarId } = await getOnboardingSettings();
  if (!ghlCalendarId) return { ...result, skipped: "no GHL calendar ID" };
  if (!ghlConfigured() && !deps.events) return { ...result, skipped: "GHL not connected" };

  // Onboardings still in progress, and those finished in the last 60 days (to catch reschedules and cancellations).
  const rows = await db.onboarding.findMany({
    where: {
      ...(opts.onboardingIds ? { id: { in: opts.onboardingIds } } : {}),
      client: { endedAt: null, email: { not: null } },
      OR: [{ completedAt: null }, { completedAt: { gte: new Date(now.getTime() - 60 * DAY) } }],
    },
    include: { client: true },
  });
  if (!rows.length) return result;

  const fetchEvents = deps.events ?? ((id: string, from: Date, to: Date) => ghlCalendarEvents(id, from, to));
  const events = await fetchEvents(ghlCalendarId, new Date(now.getTime() - 30 * DAY), new Date(now.getTime() + 180 * DAY));
  const upsert = deps.upsertContact ?? ghlUpsertContact;

  for (const o of rows) {
    result.checked += 1;
    let contactId = o.client.ghlContactId;
    if (!contactId) {
      // Same contact GHL's booking form uses: matched by email (and phone).
      contactId = await upsert({ email: o.client.email, phone: o.client.phone });
      await db.client.update({ where: { id: o.client.id }, data: { ghlContactId: contactId } });
    }
    const seen = pickCall(events, contactId);
    if (!seen) {
      // An appointment we saw before is gone from the calendar: treat it as cancelled.
      if (o.callEventId && o.callStatus !== "cancelled") {
        await db.onboarding.update({ where: { id: o.id }, data: { callStatus: "cancelled" } });
        result.cancelled += 1;
      }
      continue;
    }
    const status = seen.cancelled ? "cancelled" : "booked";
    if (o.callEventId !== seen.eventId || o.callStatus !== status || o.callStartsAt?.getTime() !== seen.startsAt.getTime()) {
      await db.onboarding.update({ where: { id: o.id }, data: { callEventId: seen.eventId, callStartsAt: seen.startsAt, callStatus: status } });
      if (seen.cancelled) result.cancelled += 1;
      else result.booked += 1;
    }
    // On the last step with a booked call: onboarding is complete.
    if (!seen.cancelled && nextStep(o, o.client.type) === "call") {
      const r = await db.onboarding.updateMany({ where: { id: o.id, callBookedAt: null }, data: { callBookedAt: now, completedAt: now, lastProgressAt: now } });
      result.completed += r.count;
    }
  }
  return result;
}
