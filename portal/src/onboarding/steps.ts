import type { Client, Onboarding, Package } from "@prisma/client";
import { db } from "@/lib/db";
import { nextStep, type OnboardingStep } from "@/domain/onboarding";
import { renderContract, sha256 } from "@/domain/contract";
import { contractFor } from "@/packages/contracts";
import { onboardingIdFromToken } from "@/onboarding/start";
import { checkIntake, getCountersigner, getOnboardingSettings, parseIntakeQuestions } from "@/settings/onboarding";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import { formatUsd } from "@/lib/money";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const BAD_LINK = "This link isn't valid. Please use the link Book Clarity sent you.";

export type Details = {
  business: string;
  firstName: string;
  signerName: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
};
const REQUIRED: (keyof Details)[] = ["business", "firstName", "signerName", "phone", "address1", "city", "state", "zip"];

export type Loaded = { onboarding: Onboarding; client: Client; pkg: Package | null; step: OnboardingStep };

/** Public: the onboarding behind a link, and the client's current step. */
export async function loadOnboarding(token: string): Promise<Loaded | { error: string; step?: undefined }> {
  const id = onboardingIdFromToken(token);
  const o = id ? await db.onboarding.findUnique({ where: { id }, include: { client: true } }) : null;
  if (!o) return { error: BAD_LINK };
  if (o.client.endedAt) return { error: "This onboarding link is no longer active. Please contact Book Clarity." };
  if (o.completedAt) return { error: "Your onboarding is already complete. Thank you! We'll see you on your onboarding call." };
  const pkg = o.packageId ? await db.package.findUnique({ where: { id: o.packageId } }) : null;
  const { client, ...onboarding } = o;
  return { onboarding, client, pkg, step: nextStep(onboarding, client.type) };
}

/** Loads the onboarding and checks the client is on `step`. */
async function at(token: string, step: OnboardingStep): Promise<Loaded | { error: string }> {
  const l = await loadOnboarding(token);
  if ("error" in l) return l;
  if (l.step !== step) return { error: "This step isn't available right now. Please reload the page." };
  return l;
}

/** Moves forward only if nobody else already completed this step (double clicks, two tabs). */
async function advance(id: string, guard: Record<string, null>, data: Record<string, unknown>, now: Date): Promise<boolean> {
  const r = await db.onboarding.updateMany({ where: { id, ...guard }, data: { ...data, lastProgressAt: now } });
  return r.count === 1;
}

export async function choosePackage(token: string, packageId: string, now: Date = new Date()): Promise<ActionResult> {
  const l = await at(token, "package");
  if ("error" in l) return { ok: false, error: l.error };
  const pkg = await db.package.findUnique({ where: { id: packageId } });
  // Custom packages are priced per client: staff choose them when starting the onboarding.
  if (!pkg || !pkg.active || pkg.isCustom) return { ok: false, error: "Please choose one of the packages shown." };
  if (!pkg.stripePriceId) return { ok: false, error: "This package can't be chosen online right now. Please contact Book Clarity." };
  const ok = await advance(l.onboarding.id, { packageId: null }, { packageId: pkg.id, monthlyCents: pkg.monthlyPriceCents, onboardingFeeCents: l.onboarding.onboardingFeeCents ?? pkg.onboardingFeeCents }, now);
  if (ok) await db.client.update({ where: { id: l.client.id }, data: { packageId: pkg.id } });
  return ok ? { ok: true } : { ok: false, error: "This step isn't available right now. Please reload the page." };
}

export async function saveDetails(token: string, d: Details, now: Date = new Date()): Promise<ActionResult> {
  const l = await at(token, "details");
  if ("error" in l) return { ok: false, error: l.error };
  const clean = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, String(v ?? "").trim()])) as Details;
  const missing = REQUIRED.filter((k) => !clean[k]);
  if (missing.length) return { ok: false, error: "Please fill in every field (Address line 2 is optional)." };
  const ok = await advance(l.onboarding.id, {}, { details: clean }, now);
  if (ok) await db.client.update({ where: { id: l.client.id }, data: { name: clean.business, phone: clean.phone, billingState: clean.state, ghlContactId: null } });
  return { ok: true };
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
const fmtWhen = (d: Date) => d.toLocaleString("en-US", { timeZone: TZ, dateStyle: "long", timeStyle: "short" });

/** The contract as the client sees it before signing (or null if the package has none). */
export async function contractPreview(l: Loaded, now: Date = new Date()) {
  if (!l.pkg) return null;
  const c = await contractFor(l.pkg);
  if (!c) return null;
  const d = (l.onboarding.details ?? {}) as Partial<Details>;
  const values = {
    date: fmtDay(now),
    client_name: d.business ?? l.client.name,
    client_first_name: d.firstName ?? "",
    phone: d.phone ?? "",
    address1: d.address1 ?? "",
    address2: d.address2 ?? "",
    city: d.city ?? "",
    state: d.state ?? "",
    zip: d.zip ?? "",
    signer_name: d.signerName ?? "",
    onboarding_fee: (l.onboarding.onboardingFeeCents ?? l.pkg.onboardingFeeCents) === 0 ? "$0.00 (waived)" : formatUsd(l.onboarding.onboardingFeeCents ?? l.pkg.onboardingFeeCents),
    monthly_amount: formatUsd(l.onboarding.monthlyCents ?? l.pkg.monthlyPriceCents),
  };
  const choices = [...c.template.matchAll(/\{\{choice:quickbooks\|([^}]*)\}\}/g)][0]?.[1].split("|") ?? [];
  return { ...c, values, quickbooksOptions: choices };
}

export type SignInput = { signerName: string; confirmDetails: boolean; agreeAutopay: boolean; quickbooks: number | null };

export async function signContract(token: string, s: SignInput, ip: string, now: Date = new Date()): Promise<ActionResult> {
  const l = await at(token, "contract");
  if ("error" in l) return { ok: false, error: l.error };
  const preview = await contractPreview(l, now);
  if (!preview) return { ok: false, error: "Your agreement isn't ready yet. Please contact Book Clarity." };
  if (!s.confirmDetails || !s.agreeAutopay) return { ok: false, error: "Please tick both boxes to agree." };
  if (preview.quickbooksOptions.length && (s.quickbooks == null || !preview.quickbooksOptions[s.quickbooks])) {
    return { ok: false, error: "Please choose a QuickBooks option." };
  }
  const expected = preview.values.signer_name.trim().toLowerCase().replace(/\s+/g, " ");
  if (s.signerName.trim().toLowerCase().replace(/\s+/g, " ") !== expected) {
    return { ok: false, error: `Please type your full name exactly as entered: ${preview.values.signer_name}` };
  }
  const { text, missing } = renderContract(preview.template, preview.values, {
    checks: { confirm_details: true, agree_autopay: true },
    choices: s.quickbooks != null ? { quickbooks: s.quickbooks } : {},
    signatures: { client: preview.values.signer_name },
    signedAt: { client: `${fmtWhen(now)} (${TZ})` },
  });
  if (missing.length) return { ok: false, error: "Some of your details are missing. Please contact Book Clarity." };

  const ok = await advance(
    l.onboarding.id,
    { signedAt: null },
    {
      signedAt: now,
      signerName: preview.values.signer_name,
      signerIp: ip,
      signedText: text,
      signedHash: sha256(text),
      contractVersion: preview.version,
      quickbooks: s.quickbooks != null ? preview.quickbooksOptions[s.quickbooks] ?? null : null,
    },
    now,
  );
  if (!ok) return { ok: false, error: "This agreement was already signed." };
  await writeAudit({ actorId: null, action: "contract_signed", entity: "Onboarding", entityId: l.onboarding.id, after: { version: preview.version, hash: sha256(text), ip } });

  const signer = await getCountersigner();
  if (signer) {
    const t = templates.countersignRequest({ name: signer.name, clientName: preview.values.client_name, packageName: l.pkg!.name, url: `${baseUrl()}/contracts/${l.onboarding.id}` });
    await sendNotice({ key: `countersign-request:${l.onboarding.id}`, kind: "countersign-request", to: { name: signer.name, email: signer.email }, email: t });
  }
  return { ok: true };
}

export async function intakeQuestions() {
  return parseIntakeQuestions((await getOnboardingSettings()).intakeQuestions);
}

/** Answers keyed q0, q1, …; stored with the question text so later edits to the questions don't lose meaning. */
export async function saveIntake(token: string, answers: Record<string, string>, now: Date = new Date()): Promise<ActionResult> {
  const l = await at(token, "intake");
  if ("error" in l) return { ok: false, error: l.error };
  const checked = checkIntake(await intakeQuestions(), answers);
  if (!checked.ok) return { ok: false, error: checked.error };
  const ok = await advance(l.onboarding.id, { intakeAt: null }, { intake: checked.answers, intakeAt: now }, now);
  return ok ? { ok: true } : { ok: false, error: "This step isn't available right now. Please reload the page." };
}

/** Until GHL calendar sync (Plan 4C): the client books on the calendar link and confirms here. */
export async function confirmCallBooked(token: string, now: Date = new Date()): Promise<ActionResult> {
  const l = await at(token, "call");
  if ("error" in l) return { ok: false, error: l.error };
  const ok = await advance(l.onboarding.id, { callBookedAt: null }, { callBookedAt: now, completedAt: now }, now);
  return ok ? { ok: true } : { ok: false, error: "This step isn't available right now. Please reload the page." };
}
