import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";

export const ALL_PERMISSIONS = [
  "clients.view",
  "clients.viewFinancials",
  "payments.view",
  "payments.viewAmounts",
  "onboarding.view",
  "reviews.view",
  "discounts.apply",
  "commissions.view",
  "commissions.markPaid",
  "ace.manage",
  "reports.view",
  "audit.view",
  "settings.manage",
  "users.manage",
] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];

const ADMIN: Permission[] = ["clients.view", "payments.view", "onboarding.view", "reviews.view"];
const OWNER: Permission[] = ALL_PERMISSIONS.filter((p) => p !== "settings.manage" && p !== "users.manage");

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
  SUPER_ADMIN: new Set(ALL_PERMISSIONS),
};

export function can(role: Role, p: Permission): boolean {
  return GRANTS[role].has(p);
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(p: Permission) {
    super(`Forbidden: missing permission ${p}`);
  }
}

export type SessionUser = { id: string; email: string; name: string; role: Role; totpEnabled: boolean };
export type CurrentSession = { user: SessionUser; twoFactorVerified: boolean } | null;

export const requiresTwoFactor = (role: Role) => role === "OWNER" || role === "SUPER_ADMIN";

/**
 * Server-side gate for every page and action. No session → /login.
 * Owner/Super Admin without a verified 2FA step → /login/2fa. Missing permission → ForbiddenError (403).
 */
export async function requirePermission(
  p: Permission,
  getSession: () => Promise<CurrentSession> = defaultGetSession,
): Promise<SessionUser> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (requiresTwoFactor(s.user.role) && !s.twoFactorVerified) redirect("/login/2fa");
  if (!can(s.user.role, p)) throw new ForbiddenError(p);
  return s.user;
}

async function defaultGetSession(): Promise<CurrentSession> {
  const { getCurrentSession } = await import("@/auth/current");
  return getCurrentSession();
}
