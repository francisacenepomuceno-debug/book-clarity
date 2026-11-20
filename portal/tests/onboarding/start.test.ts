import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { nextStep } from "@/domain/onboarding";
import { onboardingLink, onboardingIdFromToken, startOnboarding } from "@/onboarding/start";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const base = { packageId: null, details: null, signedAt: null, feePaidAt: null, intakeAt: null, callBookedAt: null, completedAt: null };

describe("nextStep", () => {
  it("walks a Direct client through every step", () => {
    const d = new Date();
    expect(nextStep(base, "DIRECT")).toBe("package");
    expect(nextStep({ ...base, packageId: "p" }, "DIRECT")).toBe("details");
    expect(nextStep({ ...base, packageId: "p", details: {} }, "DIRECT")).toBe("contract");
    expect(nextStep({ ...base, packageId: "p", details: {}, signedAt: d }, "DIRECT")).toBe("payment");
    expect(nextStep({ ...base, packageId: "p", details: {}, signedAt: d, feePaidAt: d }, "DIRECT")).toBe("intake");
    expect(nextStep({ ...base, packageId: "p", details: {}, signedAt: d, feePaidAt: d, intakeAt: d }, "DIRECT")).toBe("call");
    expect(nextStep({ ...base, packageId: "p", details: {}, signedAt: d, feePaidAt: d, intakeAt: d, callBookedAt: d }, "DIRECT")).toBe("done");
  });
  it("ACE clients skip the package and payment", () => {
    const d = new Date();
    expect(nextStep({ ...base, packageId: "p" }, "ACE")).toBe("details");
    expect(nextStep({ ...base, packageId: "p", details: {}, signedAt: d }, "ACE")).toBe("intake");
  });
});

describe("startOnboarding", () => {
  beforeEach(async () => {
    await resetDb();
    ghl.upsert.mockReset().mockResolvedValue("ct");
    ghl.send.mockReset().mockResolvedValue("m");
    process.env.PORTAL_BASE_URL = "https://portal.test";
  });

  it("Admins start a client and the invite is sent once", async () => {
    as("ADMIN");
    const r = await startOnboarding({ name: "Acme LLC", email: "a@acme.co", type: "DIRECT" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toMatch(/^https:\/\/portal\.test\/onboard\//);
    const o = await db.onboarding.findUniqueOrThrow({ where: { id: r.onboardingId }, include: { client: true } });
    expect(o.client).toMatchObject({ name: "Acme LLC", email: "a@acme.co", type: "DIRECT", status: "ONBOARDING" });
    expect(o.createdById).toBe("u1");
    expect(onboardingIdFromToken(r.url.split("/onboard/")[1])).toBe(o.id);
    expect(onboardingIdFromToken(r.url.split("/onboard/")[1] + "x")).toBeNull();
    expect(onboardingLink(o.id, "https://p")).toMatch(/^https:\/\/p\/onboard\//);
    const notes = await db.notification.findMany();
    expect(notes.map((n) => n.key)).toEqual([`onboarding-invite:${o.id}`]);
  });

  it("pre-selects a package and validates input", async () => {
    as("OWNER");
    const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_g" } });
    const r = await startOnboarding({ name: "B", email: "b@x.co", type: "DIRECT", packageId: p.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(await db.onboarding.findUniqueOrThrow({ where: { id: r.onboardingId } })).toMatchObject({ packageId: p.id, monthlyCents: 65000, onboardingFeeCents: 50000 });
    expect((await startOnboarding({ name: "", email: "b@x.co", type: "DIRECT" })).ok).toBe(false);
    expect((await startOnboarding({ name: "C", email: "not-an-email", type: "DIRECT" })).ok).toBe(false);
  });

  it("a Custom package needs a monthly price", async () => {
    as("OWNER");
    const p = await db.package.create({ data: { name: "Enterprise Custom", monthlyPriceCents: 0, onboardingFeeCents: 100000, isCustom: true, stripePriceId: "price_c" } });
    expect((await startOnboarding({ name: "C", email: "c@x.co", type: "DIRECT", packageId: p.id })).ok).toBe(false);
    expect((await startOnboarding({ name: "C", email: "c@x.co", type: "DIRECT", packageId: p.id, customMonthlyCents: 250000 })).ok).toBe(true);
  });

  it("people without onboarding access can't start one", async () => {
    sessionRef.current = null;
    await expect(startOnboarding({ name: "A", email: "a@x.co", type: "DIRECT" })).rejects.toThrow(/REDIRECT:\/login/);
  });
});
