"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/auth/password";
import { totpStep } from "@/auth/totp";
import { clearSessionCookie, getCurrentSession, setSessionCookie } from "@/auth/current";
import { requiresTwoFactor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";

export type FormState = { error?: string; email?: string };

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const LOCKED = `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`;
// Used to spend the same time on unknown emails as on real ones (no account discovery by timing).
const DUMMY_HASH = hashPassword("not-a-real-password");

async function recentFailures(action: string, entityId: string): Promise<number> {
  return db.auditLog.count({
    where: { action, entityId, at: { gt: new Date(Date.now() - LOCK_MINUTES * 60_000) } },
  });
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if ((await recentFailures("login_password_failed", email)) >= MAX_FAILURES) return { error: LOCKED, email };

  const user = await db.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
  if (!user?.passwordHash || !ok) {
    await writeAudit({ actorId: user?.id ?? null, action: "login_password_failed", entity: "Login", entityId: email });
    return { error: "Email or password is incorrect.", email };
  }
  await setSessionCookie({ userId: user.id, twoFactorVerified: false });
  await writeAudit({ actorId: user.id, action: "login_password_ok", entity: "User", entityId: user.id });
  redirect(requiresTwoFactor(user.role) ? "/login/2fa" : "/");
}

/**
 * Second step for Owners and Super Admins. Authenticators are set up only by the Super Admin
 * (scripts/create-user.ts), never from the browser, so a password alone can't bind a new device.
 */
export async function verifyTotpAction(_: FormState, form: FormData): Promise<FormState> {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id } });
  if (!user.totpSecret) {
    return { error: "Your authenticator app hasn't been set up yet. Ask the Super Admin to set it up for you." };
  }
  if ((await recentFailures("login_2fa_failed", user.id)) >= MAX_FAILURES) return { error: LOCKED };

  const step = totpStep(user.totpSecret, String(form.get("code") ?? ""));
  if (step === null) {
    await writeAudit({ actorId: user.id, action: "login_2fa_failed", entity: "User", entityId: user.id });
    return { error: "That code didn't match. Try the newest code from your app." };
  }
  if (user.totpLastStep !== null && step <= user.totpLastStep) {
    return { error: "That code was already used. Wait for the next one." };
  }
  await db.user.update({ where: { id: user.id }, data: { totpLastStep: step, totpEnabled: true } });
  await setSessionCookie({ userId: user.id, twoFactorVerified: true });
  await writeAudit({ actorId: user.id, action: "login_2fa_ok", entity: "User", entityId: user.id });
  redirect("/");
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}
