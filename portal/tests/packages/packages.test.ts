import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPackages, savePackage } from "@/packages/packages";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const OWNER = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
const ADMIN = { user: { id: "a", email: "a@x.co", name: "A", role: "ADMIN", totpEnabled: false }, twoFactorVerified: false };

beforeEach(async () => {
  await resetDb();
  sessionRef.current = OWNER;
});

describe("packages", () => {
  it("saves, lists and updates", async () => {
    const r = await savePackage({ name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, isCustom: false });
    expect(r.ok).toBe(true);
    const id = (r as { packageId: string }).packageId;
    await savePackage({ id, name: "Growth", monthlyPriceCents: 70000, onboardingFeeCents: 50000, isCustom: false });
    expect((await listPackages()).map((p) => [p.name, p.monthlyPriceCents])).toEqual([["Growth", 70000]]);
  });
  it("allows $0 only for Custom", async () => {
    expect((await savePackage({ name: "Essentials", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: false })).ok).toBe(false);
    expect((await savePackage({ name: "Custom", monthlyPriceCents: 0, onboardingFeeCents: 0, isCustom: true })).ok).toBe(true);
  });
  it("Admins can't", async () => {
    sessionRef.current = ADMIN;
    expect((await savePackage({ name: "X", monthlyPriceCents: 1, onboardingFeeCents: 0, isCustom: false })).ok).toBe(false);
  });
});
