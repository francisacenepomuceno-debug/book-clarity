import { authenticator } from "otplib";

authenticator.options = { window: 1 };
const STEP_SECONDS = 30;

export function generateTotpSecret(email: string): { secret: string; otpauthUrl: string } {
  const secret = authenticator.generateSecret();
  return { secret, otpauthUrl: authenticator.keyuri(email, "Book Clarity Portal", secret) };
}

export function verifyTotp(secret: string, token: string): boolean {
  return totpStep(secret, token) !== null;
}

/** The 30-second time step a valid code belongs to (for replay protection), or null if the code is wrong. */
export function totpStep(secret: string, token: string, now: number = Date.now()): number | null {
  try {
    const delta = authenticator.checkDelta(token.replace(/\s/g, ""), secret);
    if (delta === null) return null;
    return Math.floor(now / 1000 / STEP_SECONDS) + delta;
  } catch {
    return null;
  }
}
