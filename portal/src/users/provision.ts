import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword } from "@/auth/password";
import { generateTotpSecret } from "@/auth/totp";
import { writeAudit } from "@/audit/log";

export type NewUser = { email: string; name: string; role: Role };
export type Provisioned = { email: string; name: string; role: Role; password: string; totpSecret: string | null; otpauthUrl: string | null };

/**
 * Creates a user with a random temporary password. Owners and Super Admins also get an authenticator key.
 * The password and key are returned once and are not stored readably. `reset` overwrites an existing user.
 */
export async function provisionUser(u: NewUser, opts: { reset?: boolean; actorId?: string | null } = {}): Promise<Provisioned> {
  const email = u.email.trim().toLowerCase();
  const name = u.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (!name) throw new Error("Enter the person's name.");
  if (!["SUPER_ADMIN", "OWNER", "ADMIN"].includes(u.role)) throw new Error("Pick a role.");

  if (!opts.reset && (await db.user.findUnique({ where: { email } }))) {
    throw new Error(`A user with ${email} already exists.`);
  }
  const password = randomBytes(12).toString("base64url");
  const totp = u.role === "ADMIN" ? null : generateTotpSecret(email);
  const data = { name, role: u.role, passwordHash: await hashPassword(password), totpSecret: totp?.secret ?? null, totpEnabled: false, totpLastStep: null };
  const user = await db.user.upsert({ where: { email }, update: data, create: { email, ...data } });
  await writeAudit({ actorId: opts.actorId ?? null, action: opts.reset ? "user_reset" : "user_created", entity: "User", entityId: user.id, after: { email, role: u.role } });
  return { email, name, role: u.role, password, totpSecret: totp?.secret ?? null, otpauthUrl: totp?.otpauthUrl ?? null };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** One-time creation of the first Super Admin on a fresh deployment. Needs SETUP_TOKEN and an empty user table. */
export async function bootstrapSuperAdmin(
  token: string,
  u: { email: string; name: string },
): Promise<({ ok: true } & Provisioned) | { ok: false; error: string }> {
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.length < 16) return { ok: false, error: "Setup is not enabled on this site." };
  if (!timingSafeEqual(digest(token), digest(expected))) return { ok: false, error: "That setup code is wrong." };
  if ((await db.user.count()) > 0) return { ok: false, error: "The portal is already set up. Sign in instead." };
  try {
    return { ok: true, ...(await provisionUser({ ...u, role: "SUPER_ADMIN" })) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
