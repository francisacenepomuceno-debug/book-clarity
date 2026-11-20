import { describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { generateTotpSecret, verifyTotp } from "@/auth/totp";

describe("totp", () => {
  it("verifies a current code and rejects a wrong one", () => {
    const { secret, otpauthUrl } = generateTotpSecret("owner@bookclarity.test");
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect(verifyTotp(secret, authenticator.generate(secret))).toBe(true);
    expect(verifyTotp(secret, "000000")).toBe(false);
  });
});
