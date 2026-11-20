import type { Package } from "@prisma/client";
import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

export async function listPackages(): Promise<Package[]> {
  return db.package.findMany({ orderBy: [{ active: "desc" }, { monthlyPriceCents: "asc" }, { name: "asc" }] });
}

/** Owners keep the package price list (monthly list price drives ACE commission, spec Q1). */
export async function savePackage(i: {
  id?: string;
  name: string;
  monthlyPriceCents: number;
  onboardingFeeCents: number;
  isCustom: boolean;
  stripePriceId?: string | null;
}): Promise<ActionResult<{ packageId: string }>> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  const name = i.name.trim();
  if (!name) return { ok: false, error: "Enter a package name." };
  if (!Number.isInteger(i.monthlyPriceCents) || i.monthlyPriceCents < 0 || (!i.isCustom && i.monthlyPriceCents === 0)) {
    return { ok: false, error: "Enter the monthly price (only a Custom package can be $0; its price is set per client)." };
  }
  if (!Number.isInteger(i.onboardingFeeCents) || i.onboardingFeeCents < 0) return { ok: false, error: "Enter the onboarding fee." };
  const data = {
    name,
    monthlyPriceCents: i.monthlyPriceCents,
    onboardingFeeCents: i.onboardingFeeCents,
    isCustom: i.isCustom,
    stripePriceId: i.stripePriceId?.trim() || null,
  };
  const before = i.id ? await db.package.findUnique({ where: { id: i.id } }) : null;
  const saved = i.id ? await db.package.update({ where: { id: i.id }, data }) : await db.package.create({ data });
  await writeAudit({ actorId: actor.id, action: "package_saved", entity: "Package", entityId: saved.id, before, after: saved });
  return { ok: true, packageId: saved.id };
}
