import { db } from "@/lib/db";
import { can, ForbiddenError, requirePermission } from "@/auth/permissions";
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
  // A changed fee or a custom price is effectively a discount: Owners only (D1).
  if ((i.onboardingFeeCents != null || i.customMonthlyCents != null) && !can(actor.role, "discounts.apply")) {
    return { ok: false, error: "Only Owners can set a custom price or onboarding fee. Leave those blank, or ask an Owner." };
  }
  if (i.type === "ACE" && !i.packageId) return { ok: false, error: "Choose the ACE client's package (from their ACE slot)." };

  let pricing: { monthlyCents: number; onboardingFeeCents: number } | null = null;
  if (i.packageId) {
    const pkg = await db.package.findUnique({ where: { id: i.packageId } });
    if (!pkg || !pkg.active) return { ok: false, error: "Choose an active package." };
    pricing = pricingFor(pkg, i.customMonthlyCents, i.onboardingFeeCents);
    if (pricing.monthlyCents <= 0) return { ok: false, error: "Enter the monthly price for this Custom package." };
    if (i.type === "DIRECT" && !pkg.stripePriceId) return { ok: false, error: "Link this package to its Stripe price on the Packages page first, or the client can't be billed monthly." };
  }

  const { client, onboarding } = await db.$transaction(async (tx) => {
    const client = await tx.client.create({
      data: { name, email, phone: i.phone?.trim() || null, type: i.type, status: "ONBOARDING", packageId: i.packageId ?? null },
    });
    const onboarding = await tx.onboarding.create({
      data: { clientId: client.id, packageId: i.packageId ?? null, ...(pricing ?? { onboardingFeeCents: i.onboardingFeeCents ?? null }), createdById: actor.id },
    });
    return { client, onboarding };
  });
  await writeAudit({ actorId: actor.id, action: "onboarding_started", entity: "Client", entityId: client.id, after: { type: i.type, packageId: i.packageId ?? null } });

  const url = onboardingLink(onboarding.id);
  const t = templates.onboardingInvite({ name, url });
  await sendNotice({ key: `onboarding-invite:${onboarding.id}`, kind: "onboarding-invite", clientId: client.id, to: { name, email, phone: client.phone }, email: t, sms: t.sms });
  return { ok: true, onboardingId: onboarding.id, clientId: client.id, url };
}

/**
 * Owners: waive a new client's onboarding fee (Jose sometimes does). Allowed until a fee invoice exists or the fee
 * is paid. The client still saves a bank account or card for autopay; billing starts 14 days after that.
 * A copy the client already signed keeps the fee it showed; the waiver is in the audit log.
 */
export async function waiveOnboardingFee(onboardingId: string): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("discounts.apply");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "Only Owners can waive the onboarding fee." };
    throw e;
  }
  const o = await db.onboarding.findUnique({ where: { id: onboardingId } });
  if (!o) return { ok: false, error: "Onboarding not found." };
  const done = await db.onboarding.updateMany({
    where: { id: onboardingId, feePaidAt: null, feeSubmittedAt: null, feeInvoiceId: null, completedAt: null },
    data: { onboardingFeeCents: 0 },
  });
  if (done.count !== 1) return { ok: false, error: "The fee can't be waived now: the client has already paid it or a payment is under way." };
  await writeAudit({ actorId: actor.id, action: "onboarding_fee_waived", entity: "Onboarding", entityId: onboardingId, after: { previousCents: o.onboardingFeeCents } });
  return { ok: true };
}
