import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/auth/password";
import { signSession, verifySession } from "@/auth/session";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
});

describe("session token", () => {
  it("round-trips and rejects tampering", async () => {
    const t = await signSession({ userId: "u1", twoFactorVerified: false });
    expect(await verifySession(t)).toEqual({ userId: "u1", twoFactorVerified: false });
    expect(await verifySession(t.slice(0, -2) + "xx")).toBeNull();
    expect(await verifySession("garbage")).toBeNull();
  });
});
