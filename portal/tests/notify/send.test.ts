import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sendNotice } from "@/notify/send";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({
  configured: true,
  upsert: vi.fn(async () => "ct_1"),
  send: vi.fn(async () => "msg"),
}));
vi.mock("@/ghl/client", () => ({
  ghlConfigured: () => ghl.configured,
  ghlUpsertContact: ghl.upsert,
  ghlSendMessage: ghl.send,
  GhlError: class extends Error {},
}));

let clientId: string;
const notice = (over: Record<string, unknown> = {}) => ({
  key: "k1",
  kind: "test",
  clientId,
  to: { name: "Acme", email: "a@acme.test", phone: "+15550000000" },
  email: { subject: "Hello", html: "<p>Hi</p>" },
  sms: "Hi",
  ...over,
});

beforeEach(async () => {
  await resetDb();
  ghl.configured = true;
  ghl.upsert.mockReset().mockResolvedValue("ct_1");
  ghl.send.mockReset().mockResolvedValue("msg");
  clientId = (await db.client.create({ data: { name: "Acme", email: "a@acme.test" } })).id;
});

describe("sendNotice", () => {
  it("sends email and SMS once per key and remembers the GHL contact", async () => {
    expect(await sendNotice(notice())).toBe("SENT");
    expect(ghl.send).toHaveBeenCalledTimes(2);
    expect(await sendNotice(notice())).toBe("DUPLICATE");
    expect(ghl.send).toHaveBeenCalledTimes(2);
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).ghlContactId).toBe("ct_1");
    expect(await db.notification.findUniqueOrThrow({ where: { key: "k1" } })).toMatchObject({ status: "SENT", channels: "email,sms" });
  });

  it("is skipped, not thrown, when GHL isn't configured", async () => {
    ghl.configured = false;
    expect(await sendNotice(notice())).toBe("SKIPPED");
    expect(ghl.send).not.toHaveBeenCalled();
    expect((await db.notification.findUniqueOrThrow({ where: { key: "k1" } })).error).toMatch(/not configured/);
  });

  it("a GHL failure is logged and retried once, then given up", async () => {
    ghl.send.mockRejectedValue(new Error("GHL 500"));
    expect(await sendNotice(notice())).toBe("FAILED");
    expect(await sendNotice(notice())).toBe("FAILED");
    expect(await sendNotice(notice())).toBe("DUPLICATE");
    expect((await db.notification.findUniqueOrThrow({ where: { key: "k1" } })).attempts).toBe(2);
  });

  it("phone only → SMS only; no contact details → skipped", async () => {
    expect(await sendNotice(notice({ key: "sms-only", to: { name: "Acme", phone: "+15550000000" } }))).toBe("SENT");
    expect(ghl.send).toHaveBeenCalledTimes(1);
    expect((ghl.send.mock.calls[0] as unknown[])[0]).toMatchObject({ type: "SMS" });
    expect(await sendNotice(notice({ key: "none", to: { name: "Acme" } }))).toBe("SKIPPED");
    expect((await db.notification.findUniqueOrThrow({ where: { key: "none" } })).error).toMatch(/no contact details/);
  });
});
