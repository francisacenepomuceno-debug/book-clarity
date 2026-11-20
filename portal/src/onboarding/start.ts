import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { signLink, verifyLink } from "@/lib/links";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import type { ActionResult } from "@/billing/discounts";

const PURPOSE = "onboarding";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const onboardingLink = (onboardingId: string, base: string = baseUrl()) => `${base}/onboard/${signLink(PURPOSE, onboardingId)}`;
export const onboardingIdFromToken = (token: string) => verifyLink(PURPOSE, token);

export type StartInput = {
  name: string;
  email: string;
  phone?: string | null;
  type: "DIRECT" | "ACE";
  packageId?: string | null;
  /** Custom packages only: the client's monthly price. */
  customMonthlyCents?: number | null;
  /** Overrides the package's onboarding fee. */
  onboardingFeeCents?: number | null;
};

/** Package pricing for one client: the list price, or the per-client price for a Custom package. */
export function pricingFor(pkg: { monthlyPriceCents: number; onboardingFeeCents: number; isCustom: boolean }, custom?: number | null, fee?: number | null) {
  const monthlyCents = pkg.isCustom ? custom ?? 0 : pkg.monthlyPriceCents;
  return { monthlyCents, onboardingFeeCents: fee ?? pkg.onboardingFeeCents };
}

/**
 * Staff (Admins, Owners): adds a new client and sends them their onboarding link.
 * Commission and discounts are not set here; Owners set them on the client page (D1).
 */
export async function startOnboarding(i: StartInput): Promise<ActionResult<{ onboardingId: string; clientId: string; url: string }>> {
  const actor = await requirePermission("onboarding.view");
  const name = i.name.trim();
  const email = i.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Enter the client's name." };
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (i.onboardingFeeCents != null && (!Number.isInteger(i.onboardingFeeCents) || i.onboardingFeeCents < 0)) return { ok: false, error: "Enter a valid onboarding fee." };

  let pricing: { monthlyCents: number; onboardingFeeCents: number } | null = null;
  if (i.packageId) {
    const pkg = await db.package.findUnique({ where: { id: i.packageId } });
    if (!pkg || !pkg.active) return { ok: false, error: "Choose an active package." };
    pricing = pricingFor(pkg, i.customMonthlyCents, i.onboardingFeeCents);
    if (pricing.monthlyCents <= 0) return { ok: false, error: "Enter the monthly price for this Custom package." };
  }

  const { client, onboarding } = await db.$transaction(async (tx) => {
    const client = await tx.client.create({
      data: { name, email, phone: i.phone?.trim() || null, type: i.type, status: "ONBOARDING", packageId: i.packageId ?? null },
    });
    const onboarding = await tx.onboarding.create({
      data: { clientId: client.id, packageId: i.packageId ?? null, ...(pricing ?? {}), createdById: actor.id },
    });
    return { client, onboarding };
  });
  await writeAudit({ actorId: actor.id, action: "onboarding_started", entity: "Client", entityId: client.id, after: { type: i.type, packageId: i.packageId ?? null } });

  const url = onboardingLink(onboarding.id);
  const t = templates.onboardingInvite({ name, url });
  await sendNotice({ key: `onboarding-invite:${onboarding.id}`, kind: "onboarding-invite", clientId: client.id, to: { name, email, phone: client.phone }, email: t, sms: t.sms });
  return { ok: true, onboardingId: onboarding.id, clientId: client.id, url };
}
