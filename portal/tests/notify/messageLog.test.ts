import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { messageLog } from "@/notify/log";
import { sendNotice } from "@/notify/send";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: "OWNER" | "ADMIN") => { sessionRef.current = { user: { id: "u", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true }; };

beforeEach(async () => {
  await resetDb();
  as("OWNER");
});

describe("message log", () => {
  it("lists a message that wasn't sent, with the reason, and the client's company name", async () => {
    const c = await db.client.create({ data: { name: "Jane Doe", companyName: "Acme LLC", email: "jane@x.co" } });
    await db.setting.update({ where: { key: "launch" }, data: { value: { noticesOn: false, checks: {} } } });
    expect(await sendNotice({ key: "onboarding-invite:t1", kind: "onboarding-invite", clientId: c.id, to: { name: "Jane Doe", email: "jane@x.co" }, email: { subject: "s", html: "h" } })).toBe("SKIPPED");
    const log = await messageLog();
    expect(log.counts).toEqual({ SKIPPED: 1 });
    expect(log.rows[0]).toMatchObject({ kindLabel: "Onboarding invite", clientName: "Acme LLC", status: "SKIPPED" });
    expect(log.rows[0].why).toMatch(/Notices aren't turned on/);
    expect((await messageLog({ status: "SENT" })).rows).toEqual([]);
  });

  it("is for Owners and Super Admin only", async () => {
    as("ADMIN");
    await expect(messageLog()).rejects.toThrow(/Forbidden|REDIRECT/);
  });
});

describe("message names", () => {
  it("reads naturally, including types that carry a day in their name", async () => {
    const { messageKindLabel } = await import("@/notify/log");
    expect(messageKindLabel("payment_failed_3")).toBe("Payment failed (day 3)");
    expect(messageKindLabel("contract-executed-staff")).toBe("Signed agreement copy (staff)");
    expect(messageKindLabel("something-new")).toBe("something-new");
  });
});
