import { authenticator } from "otplib";

authenticator.options = { window: 1 };

export function generateTotpSecret(email: string): { secret: string; otpauthUrl: string } {
  const secret = authenticator.generateSecret();
  return { secret, otpauthUrl: authenticator.keyuri(email, "Book Clarity Portal", secret) };
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s/g, ""), secret });
  } catch {
    return false;
  }
}
