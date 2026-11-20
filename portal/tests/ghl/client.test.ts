import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhlError, ghlConfigured, ghlSendMessage, ghlUpsertContact } from "@/ghl/client";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.GHL_API_TOKEN = "pit-test";
  process.env.GHL_LOCATION_ID = "loc_bc";
});
afterEach(() => {
  delete process.env.GHL_API_TOKEN;
  delete process.env.GHL_LOCATION_ID;
});

describe("GHL client", () => {
  it("is configured only with both token and location", () => {
    expect(ghlConfigured()).toBe(true);
    delete process.env.GHL_LOCATION_ID;
    expect(ghlConfigured()).toBe(false);
  });

  it("upserts a contact in Book Clarity's location", async () => {
    const f = vi.fn(async () => ok({ contact: { id: "ct_1" } }));
    expect(await ghlUpsertContact({ name: "Acme LLC", email: "a@acme.test", phone: null }, f as unknown as typeof fetch)).toBe("ct_1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer pit-test", Version: "2021-07-28", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ locationId: "loc_bc", name: "Acme LLC", email: "a@acme.test" });
  });

  it("sends an email or SMS through Conversations", async () => {
    const f = vi.fn(async () => ok({ messageId: "msg_1", conversationId: "cv" }));
    expect(await ghlSendMessage({ contactId: "ct_1", type: "SMS", message: "Hi" }, f as unknown as typeof fetch)).toBe("msg_1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://services.leadconnectorhq.com/conversations/messages");
    expect(JSON.parse(String(init.body))).toEqual({ type: "SMS", contactId: "ct_1", message: "Hi" });
  });

  it("throws GhlError with the HTTP status", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 422 }));
    await expect(ghlSendMessage({ contactId: "x", type: "Email", subject: "s", html: "h" }, f as unknown as typeof fetch)).rejects.toMatchObject({ status: 422 });
    await expect(ghlSendMessage({ contactId: "x", type: "Email", subject: "s", html: "h" }, f as unknown as typeof fetch)).rejects.toBeInstanceOf(GhlError);
  });
});
