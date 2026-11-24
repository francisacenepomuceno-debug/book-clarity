/**
 * GoHighLevel API v2 client for Book Clarity's own GHL location (Private Integration token).
 * Never point this at another business's location.
 */
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

export class GhlError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID);
}

async function call<T>(path: string, body: unknown, f: typeof fetch): Promise<T> {
  const res = await f(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
      Version: VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GhlError(res.status, `GHL ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string, f: typeof fetch): Promise<T> {
  const res = await f(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.GHL_API_TOKEN}`, Version: VERSION, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GhlError(res.status, `GHL ${path.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type GhlCalendarEvent = {
  id: string;
  contactId?: string | null;
  calendarId?: string | null;
  startTime: string;
  appointmentStatus?: string | null;
  deleted?: boolean | null;
};

/** Appointments on one of Book Clarity's calendars between two times (needs calendars/events.readonly). */
export async function ghlCalendarEvents(calendarId: string, from: Date, to: Date, f: typeof fetch = fetch): Promise<GhlCalendarEvent[]> {
  const q = new URLSearchParams({ locationId: process.env.GHL_LOCATION_ID!, calendarId, startTime: String(from.getTime()), endTime: String(to.getTime()) });
  const r = await get<{ events?: GhlCalendarEvent[] }>(`/calendars/events?${q}`, f);
  return r.events ?? [];
}

/** Creates or updates a contact (matched by email/phone) and returns its id. */
export async function ghlUpsertContact(
  i: { name?: string | null; email?: string | null; phone?: string | null },
  f: typeof fetch = fetch,
): Promise<string> {
  const body: Record<string, string> = { locationId: process.env.GHL_LOCATION_ID! };
  if (i.name) body.name = i.name;
  if (i.email) body.email = i.email;
  if (i.phone) body.phone = i.phone;
  const r = await call<{ contact: { id: string } }>("/contacts/upsert", body, f);
  return r.contact.id;
}

/** Sends an email or SMS to a contact through GHL Conversations; returns the message id. */
export async function ghlSendMessage(
  i: { contactId: string; type: "Email" | "SMS"; subject?: string; html?: string; message?: string },
  f: typeof fetch = fetch,
): Promise<string> {
  const body: Record<string, string> = { type: i.type, contactId: i.contactId };
  if (i.type === "Email") {
    body.subject = i.subject ?? "";
    body.html = i.html ?? "";
  } else {
    body.message = i.message ?? "";
  }
  const r = await call<{ messageId: string }>("/conversations/messages", body, f);
  return r.messageId;
}
