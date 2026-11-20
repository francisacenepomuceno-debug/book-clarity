import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticator } from "otplib";
import { db } from "@/lib/db";
import { verifyPassword } from "@/auth/password";
import { provisionUser, bootstrapSuperAdmin } from "@/users/provision";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

beforeEach(async () => {
  await resetDb();
  delete process.env.SETUP_TOKEN;
});

describe("provisionUser", () => {
  it("Owners get a working password and authenticator key", async () => {
    const r = await provisionUser({ email: " Jose@BookClarity.com ", name: "Jose", role: "OWNER" });
    const u = await db.user.findUniqueOrThrow({ where: { email: "jose@bookclarity.com" } });
    expect(await verifyPassword(r.password, u.passwordHash!)).toBe(true);
    expect(r.totpSecret).toBe(u.totpSecret);
    expect(r.otpauthUrl).toContain("otpauth://totp/");
    expect(authenticator.check(authenticator.generate(r.totpSecret!), u.totpSecret!)).toBe(true);
  });
  it("Admins get a password and no authenticator", async () => {
    const r = await provisionUser({ email: "alex@bookclarity.com", name: "Alex", role: "ADMIN" });
    expect(r.totpSecret).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { email: "alex@bookclarity.com" } })).totpSecret).toBeNull();
  });
  it("rejects a bad email or blank name", async () => {
    await expect(provisionUser({ email: "nope", name: "X", role: "ADMIN" })).rejects.toThrow(/email/i);
    await expect(provisionUser({ email: "a@b.co", name: " ", role: "ADMIN" })).rejects.toThrow(/name/i);
  });
});

describe("bootstrapSuperAdmin", () => {
  it("is disabled when no SETUP_TOKEN is configured", async () => {
    expect(await bootstrapSuperAdmin("anything", { email: "me@x.co", name: "Me" })).toEqual({ ok: false, error: expect.stringMatching(/not enabled/) });
    expect(await db.user.count()).toBe(0);
  });
  it("refuses a wrong setup code", async () => {
    process.env.SETUP_TOKEN = "correct-horse-battery-staple";
    expect((await bootstrapSuperAdmin("wrong", { email: "me@x.co", name: "Me" })).ok).toBe(false);
    expect(await db.user.count()).toBe(0);
  });
  it("creates the first Super Admin once, then refuses", async () => {
    process.env.SETUP_TOKEN = "correct-horse-battery-staple";
    const r = await bootstrapSuperAdmin("correct-horse-battery-staple", { email: "me@x.co", name: "Me" });
    expect(r).toMatchObject({ ok: true, password: expect.any(String), totpSecret: expect.any(String) });
    expect((await db.user.findUniqueOrThrow({ where: { email: "me@x.co" } })).role).toBe("SUPER_ADMIN");
    const again = await bootstrapSuperAdmin("correct-horse-battery-staple", { email: "evil@x.co", name: "Evil" });
    expect(again).toEqual({ ok: false, error: expect.stringMatching(/already/) });
  });
});

describe("createUserAction", () => {
  const form = () => { const f = new FormData(); f.set("email", "albert@bookclarity.com"); f.set("name", "Albert"); f.set("role", "OWNER"); return f; };
  it("Owners can't create users", async () => {
    const { createUserAction } = await import("@/users/actions");
    sessionRef.current = { user: { id: "o", email: "o@x.co", name: "O", role: "OWNER", totpEnabled: true }, twoFactorVerified: true };
    expect(await createUserAction({}, form())).toEqual({ error: "You don't have permission to do that." });
    expect(await db.user.count()).toBe(0);
  });
  it("the Super Admin can, and sees the sign-in details once", async () => {
    const { createUserAction } = await import("@/users/actions");
    sessionRef.current = { user: { id: "s", email: "s@x.co", name: "S", role: "SUPER_ADMIN", totpEnabled: true }, twoFactorVerified: true };
    const r = await createUserAction({}, form());
    expect(r).toMatchObject({ created: { email: "albert@bookclarity.com", role: "OWNER", password: expect.any(String), totpSecret: expect.any(String) } });
  });
  it("won't silently reset an existing user", async () => {
    const { createUserAction } = await import("@/users/actions");
    sessionRef.current = { user: { id: "s", email: "s@x.co", name: "S", role: "SUPER_ADMIN", totpEnabled: true }, twoFactorVerified: true };
    await createUserAction({}, form());
    expect((await createUserAction({}, form())).error).toMatch(/already exists/);
  });
});
