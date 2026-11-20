import { describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, can, ForbiddenError, requirePermission, type Permission } from "@/auth/permissions";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const ADMIN_ALLOWED: Permission[] = ["clients.view", "payments.view", "onboarding.view", "reviews.view"];

describe("can", () => {
  it("Admins get only the four views", () => {
    for (const p of ALL_PERMISSIONS) expect(can("ADMIN", p), p).toBe(ADMIN_ALLOWED.includes(p));
  });
  it("Owners get everything except settings and users", () => {
    for (const p of ALL_PERMISSIONS) expect(can("OWNER", p), p).toBe(p !== "settings.manage" && p !== "users.manage");
  });
  it("Super Admins get everything", () => {
    for (const p of ALL_PERMISSIONS) expect(can("SUPER_ADMIN", p), p).toBe(true);
  });
});

const user = (role: "ADMIN" | "OWNER" | "SUPER_ADMIN", twoFactorVerified = true) => ({
  user: { id: "u1", email: "x@y.z", name: "X", role, totpEnabled: true },
  twoFactorVerified,
});

describe("requirePermission", () => {
  it("rejects an Admin calling an Owner-only action", async () => {
    await expect(requirePermission("discounts.apply", async () => user("ADMIN"))).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("returns the user when allowed", async () => {
    await expect(requirePermission("discounts.apply", async () => user("OWNER"))).resolves.toMatchObject({ role: "OWNER" });
  });
  it("redirects to login with no session", async () => {
    await expect(requirePermission("clients.view", async () => null)).rejects.toThrow("REDIRECT:/login");
  });
  it("treats an Owner without 2FA as not fully signed in", async () => {
    await expect(requirePermission("clients.view", async () => user("OWNER", false))).rejects.toThrow("REDIRECT:/login/2fa");
  });
  it("does not require 2FA for Admins", async () => {
    await expect(requirePermission("clients.view", async () => user("ADMIN", false))).resolves.toMatchObject({ role: "ADMIN" });
  });
});
