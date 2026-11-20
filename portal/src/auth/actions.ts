"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifyPassword } from "@/auth/password";
import { generateTotpSecret, verifyTotp } from "@/auth/totp";
import { clearSessionCookie, getCurrentSession, setSessionCookie } from "@/auth/current";
import { requiresTwoFactor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";

export type FormState = { error?: string; email?: string };

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const user = await db.user.findUnique({ where: { email } });
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "Email or password is incorrect.", email };
  }
  await setSessionCookie({ userId: user.id, twoFactorVerified: false });
  await writeAudit({ actorId: user.id, action: "login_password_ok", entity: "User", entityId: user.id });
  redirect(requiresTwoFactor(user.role) ? "/login/2fa" : "/");
}

/** Starts enrolment for a signed-in Owner/Super Admin who has no 2FA yet. Returns the secret to show once. */
export async function startTotpEnrolment(): Promise<{ secret: string; otpauthUrl: string } | null> {
  const s = await getCurrentSession();
  if (!s || s.user.totpEnabled) return null;
  const { secret, otpauthUrl } = generateTotpSecret(s.user.email);
  await db.user.update({ where: { id: s.user.id }, data: { totpSecret: secret } });
  return { secret, otpauthUrl };
}

export async function verifyTotpAction(_: FormState, form: FormData): Promise<FormState> {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  const code = String(form.get("code") ?? "");
  if (!user.totpSecret || !verifyTotp(user.totpSecret, code)) {
    await writeAudit({ actorId: user.id, action: "login_2fa_failed", entity: "User", entityId: user.id });
    return { error: "That code didn't match. Try the newest code from your app." };
  }
  if (!user.totpEnabled) await db.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
  await setSessionCookie({ userId: user.id, twoFactorVerified: true });
  await writeAudit({ actorId: user.id, action: "login_2fa_ok", entity: "User", entityId: user.id });
  redirect("/");
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}
