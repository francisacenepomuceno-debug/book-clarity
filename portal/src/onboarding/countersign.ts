import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import { getOnboardingSettings } from "@/settings/onboarding";
import { contractCopyLink } from "@/onboarding/contractCopies";
import type { ActionResult } from "@/billing/discounts";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const PENDING_LINE = "Awaiting countersignature by Book Clarity, LLC";

/** The fully signed copy: the client's signed text with Book Clarity's signature in place of the pending line. */
export function executedText(signedText: string, countersignerName: string, when: string): string {
  return signedText.replace(PENDING_LINE, `Signed electronically by ${countersignerName} for Book Clarity, LLC on ${when}`);
}

const fmtWhen = (d: Date) => `${d.toLocaleString("en-US", { timeZone: TZ, dateStyle: "long", timeStyle: "short" })} (${TZ})`;

/** For the countersign page (Owners). */
export async function countersignView(onboardingId: string) {
  await requirePermission("ace.manage");
  const o = await db.onboarding.findUnique({ where: { id: onboardingId }, include: { client: { include: { package: true } } } });
  if (!o?.signedText) return null;
  const by = o.countersignedById ? await db.user.findUnique({ where: { id: o.countersignedById } }) : null;
  return {
    id: o.id,
    clientName: o.client.name,
    packageName: o.client.package?.name ?? null,
    signerName: o.signerName,
    signedAt: o.signedAt,
    signerIp: o.signerIp,
    signedHash: o.signedHash,
    contractVersion: o.contractVersion,
    countersignedAt: o.countersignedAt,
    countersignedBy: by?.name ?? null,
    text: o.countersignedAt && by ? executedText(o.signedText, by.name, fmtWhen(o.countersignedAt)) : o.signedText,
  };
}

/** Owners / Super Admin: countersign a client's agreement, then email the client the fully signed copy. */
export async function countersign(onboardingId: string, now: Date = new Date()): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "Only Owners can countersign agreements." };
    throw e;
  }
  const done = await db.onboarding.updateMany({
    where: { id: onboardingId, signedAt: { not: null }, countersignedAt: null },
    data: { countersignedAt: now, countersignedById: actor.id },
  });
  if (done.count !== 1) return { ok: false, error: "This agreement isn't waiting for a countersignature." };
  const o = await db.onboarding.findUniqueOrThrow({ where: { id: onboardingId }, include: { client: true } });
  await writeAudit({ actorId: actor.id, action: "contract_countersigned", entity: "Onboarding", entityId: o.id, after: { signedHash: o.signedHash } });
  const text = executedText(o.signedText ?? "", actor.name, fmtWhen(now));
  const downloadUrl = contractCopyLink(o.id, baseUrl());
  // The fully signed copy goes to both parties and to the office copy address (Settings → Onboarding).
  const t = templates.contractExecuted({ name: o.client.name, text, downloadUrl });
  await sendNotice({ key: `contract-executed:${o.id}`, kind: "contract-executed", clientId: o.clientId, to: { name: o.client.name, email: o.client.email }, email: t });
  const staff = templates.contractExecutedCopy({ clientName: o.client.name, text, downloadUrl });
  await sendNotice({ key: `contract-executed-staff:${o.id}:${actor.id}`, kind: "contract-executed-staff", to: { name: actor.name, email: actor.email }, email: staff });
  const copyTo = (await getOnboardingSettings()).contractCopyEmail;
  if (copyTo && copyTo.toLowerCase() !== actor.email.toLowerCase()) {
    await sendNotice({ key: `contract-executed-copy:${o.id}`, kind: "contract-executed-copy", to: { name: "Book Clarity", email: copyTo }, email: staff });
  }
  return { ok: true };
}
