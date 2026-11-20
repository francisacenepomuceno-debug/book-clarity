import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { contractFor, loadDefaultContracts, saveContract } from "@/packages/contracts";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

beforeEach(async () => { await resetDb(); as("OWNER"); });

describe("package contracts", () => {
  it("loads repo defaults by package name, once", async () => {
    await db.package.create({ data: { name: "Growth", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    await db.package.create({ data: { name: "Odd", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    expect(await loadDefaultContracts()).toEqual(["Growth"]);
    expect(await loadDefaultContracts()).toEqual([]);
  });
  it("falls back to the repo default before one is saved", async () => {
    const c = await contractFor({ name: "Essentials", contractTemplate: null });
    expect(c?.template).toMatch(/\{\{signature:client\}\}/);
  });
  it("Owners edit a contract (new version); Admins can't", async () => {
    const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 1, onboardingFeeCents: 0 } });
    expect(await saveContract(p.id, "Hello {{client_name}} {{signature:client}}")).toEqual({ ok: true });
    const v1 = (await db.package.findUniqueOrThrow({ where: { id: p.id } })).contractVersion;
    await saveContract(p.id, "Hi {{client_name}} {{signature:client}}");
    expect((await db.package.findUniqueOrThrow({ where: { id: p.id } })).contractVersion).not.toBe(v1);
    expect((await saveContract(p.id, "no signature line")).ok).toBe(false);
    as("ADMIN");
    expect(await saveContract(p.id, "x {{signature:client}}")).toEqual({ ok: false, error: "You don't have permission to do that." });
  });
});
