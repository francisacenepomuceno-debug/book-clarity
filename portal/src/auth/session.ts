import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "bc_session";
export const SESSION_HOURS = 12;
export type SessionClaims = { userId: string; twoFactorVerified: boolean };

const key = () => new TextEncoder().encode(process.env.AUTH_SECRET ?? "");

export async function signSession(c: SessionClaims): Promise<string> {
  if ((process.env.AUTH_SECRET ?? "").length < 32) throw new Error("AUTH_SECRET must be at least 32 characters");
  return new SignJWT({ tfa: c.twoFactorVerified })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    return { userId: payload.sub, twoFactorVerified: payload.tfa === true };
  } catch {
    return null;
  }
}
