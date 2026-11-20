import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, SESSION_HOURS, signSession, verifySession, type SessionClaims } from "@/auth/session";
import type { CurrentSession } from "@/auth/permissions";

export async function getCurrentSession(): Promise<CurrentSession> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySession(token);
  if (!claims) return null;
  const u = await db.user.findUnique({ where: { id: claims.userId } });
  if (!u) return null;
  return {
    user: { id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: u.totpEnabled },
    twoFactorVerified: claims.twoFactorVerified,
  };
}

export async function setSessionCookie(c: SessionClaims) {
  (await cookies()).set(SESSION_COOKIE, await signSession(c), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}
