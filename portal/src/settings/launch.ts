import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { ghlConfigured } from "@/ghl/client";
import { getFeeSettings } from "@/settings/cardFee";
import { getOnboardingSettings } from "@/settings/onboarding";
import { contractFor } from "@/packages/contracts";
import type { ActionResult } from "@/billing/discounts";

/** Things only a person can confirm before go-live (spec §7.3, §14, §17). */
export const MANUAL_CHECKS = [
  { key: "surchargeConfirmed", label: "Card surcharge registration and state rules confirmed with Stripe or your accountant" },
  { key: "clientsNotified", label: "Existing card-paying clients told about the 3% credit-card fee" },
  { key: "stripeRemindersOff", label: "Stripe's own customer reminder emails turned off (so clients don't get two)" },
  { key: "customerPortal", label: "Stripe customer portal set up: card and bank account allowed, cancelling turned off" },
  { key: "webhookEvents", label: "Stripe webhook sends every event listed in the deploy guide" },
  { key: "testRun", label: "A test-mode onboarding done end to end, once by card and once by bank (ACH)" },
  { key: "historyLoaded", label: "Invoice history loaded (the \"Load invoice history\" button below)" },
] as const;
export type CheckKey = (typeof MANUAL_CHECKS)[number]["key"];

type LaunchValue = { noticesOn: boolean; checks: Partial<Record<CheckKey, { done: boolean; by: string; byName: string; at: string }>> };
const KEY = "launch";

async function read(): Promise<LaunchValue> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const v = (row?.value ?? {}) as Partial<LaunchValue>;
  return { noticesOn: v.noticesOn === true, checks: v.checks ?? {} };
}
async function write(v: LaunchValue) {
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: v as unknown as Prisma.InputJsonValue }, update: { value: v as unknown as Prisma.InputJsonValue } });
}

/** Client and staff notices (GHL email/SMS) go out only after the Super Admin turns them on at launch. */
export async function noticesOn(): Promise<boolean> {
  return (await read()).noticesOn;
}

async function superAdmin() {
  try {
    return await requirePermission("settings.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}
const FORBIDDEN = { ok: false as const, error: "Only the Super Admin can change launch settings." };

/** Active ACE clients without a start date: none may exist before notices or the card fee go on (spec §18 D2). */
async function aceWithoutStart(): Promise<string[]> {
  const ace = await db.client.findMany({ where: { type: "ACE", endedAt: null }, select: { name: true, aceSlotId: true } });
  const slots = await db.aceSlot.findMany({ where: { id: { in: ace.map((c) => c.aceSlotId).filter((x): x is string => !!x) } } });
  const started = new Set(slots.filter((s) => s.startDate).map((s) => s.id));
  return ace.filter((c) => !c.aceSlotId || !started.has(c.aceSlotId)).map((c) => c.name);
}

const names = (list: string[]) => (list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", "));

export async function launchStatus(now: Date = new Date()) {
  const v = await read();
  const [packages, noPackage, aceMissing, unassigned, lastEvent, onboarding, users] = await Promise.all([
    db.package.findMany({ where: { active: true } }),
    db.client.findMany({ where: { packageId: null, endedAt: null }, select: { name: true } }),
    aceWithoutStart(),
    db.client.findMany({
      where: { type: "DIRECT", endedAt: null, stripeSubscriptionId: { not: null }, NOT: { id: { in: (await db.commissionShare.findMany({ distinct: ["clientId"], select: { clientId: true } })).map((s) => s.clientId) } } },
      select: { name: true },
    }),
    db.stripeEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
    getOnboardingSettings(),
    db.user.findMany({ select: { id: true, name: true } }),
  ]);
  const unpriced = packages.filter((p) => !p.stripePriceId).map((p) => p.name);
  const noContract = (await Promise.all(packages.map(async (p) => ((await contractFor(p)) ? null : p.name)))).filter((x): x is string => !!x);
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const automatic = [
    { key: "stripeLive", label: "Stripe live key in use", ok: /^(sk|rk)_live_/.test(key), detail: key ? (key.includes("_test_") ? "test key" : "") : "not set" },
    { key: "webhookSecret", label: "Stripe webhook signing secret set", ok: !!process.env.STRIPE_WEBHOOK_SECRET, detail: "" },
    { key: "webhookRecent", label: "Stripe webhook received in the last 48 hours", ok: !!lastEvent && now.getTime() - lastEvent.receivedAt.getTime() < 48 * 3600_000, detail: lastEvent ? `last ${lastEvent.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "none yet" },
    { key: "cron", label: "Daily job secret (CRON_SECRET) set", ok: !!process.env.CRON_SECRET, detail: "" },
    { key: "baseUrl", label: "Portal address (PORTAL_BASE_URL) set", ok: !!process.env.PORTAL_BASE_URL, detail: process.env.PORTAL_BASE_URL ?? "" },
    { key: "ghl", label: "Book Clarity's GHL connected", ok: ghlConfigured(), detail: "" },
    { key: "packagesPriced", label: "Every active package linked to its Stripe price", ok: packages.length > 0 && unpriced.length === 0, detail: packages.length ? names(unpriced) : "no packages yet" },
    { key: "packagesContract", label: "Every active package has a contract", ok: noContract.length === 0, detail: names(noContract) },
    { key: "clientsHavePackages", label: "Every active client linked to a package", ok: noPackage.length === 0, detail: names(noPackage.map((c) => c.name)) },
    { key: "commissionOwners", label: "Every active Direct client has a commission owner", ok: unassigned.length === 0, detail: names(unassigned.map((c) => c.name)) },
    { key: "aceStartDates", label: "Every active ACE client has a start date", ok: aceMissing.length === 0, detail: names(aceMissing) },
    { key: "bookingLink", label: "Onboarding call booking link set (Settings → Onboarding)", ok: !!onboarding.calendarUrl, detail: onboarding.calendarUrl ? "" : "booking link not set" },
    { key: "calendarSync", label: "GHL calendar ID set, so booked calls show in the portal (Settings → Onboarding)", ok: !!onboarding.ghlCalendarId, detail: onboarding.ghlCalendarId ? "" : "calendar ID not set; clients confirm their booking themselves" },
  ];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const manual = MANUAL_CHECKS.map((m) => {
    const c = v.checks[m.key];
    return { ...m, done: !!c?.done, by: c ? c.byName ?? userName.get(c.by) ?? "Former user" : null, at: c?.at ?? null };
  });
  return { noticesOn: v.noticesOn, cardFee: await getFeeSettings(), automatic, manual };
}

export async function setManualCheck(key: CheckKey, done: boolean): Promise<ActionResult> {
  const actor = await superAdmin();
  if (!actor) return FORBIDDEN;
  if (!MANUAL_CHECKS.some((m) => m.key === key)) return { ok: false, error: "Unknown checklist item." };
  const v = await read();
  v.checks[key] = { done, by: actor.id, byName: actor.name, at: new Date().toISOString() };
  await write(v);
  await writeAudit({ actorId: actor.id, action: "launch_check", entity: "Setting", entityId: KEY, after: { key, done } });
  return { ok: true };
}

export async function setNoticesOn(on: boolean): Promise<ActionResult> {
  const actor = await superAdmin();
  if (!actor) return FORBIDDEN;
  const v = await read();
  if (on) {
    const ace = await aceWithoutStart();
    if (ace.length) return { ok: false, error: `Give every ACE client a start date first (${names(ace)}), so no prepaid client is reminded to pay.` };
    if (!ghlConfigured()) return { ok: false, error: "Connect Book Clarity's GHL first (GHL_API_TOKEN and GHL_LOCATION_ID)." };
    if (process.env.NODE_ENV === "production" && !process.env.PORTAL_BASE_URL) return { ok: false, error: "Set PORTAL_BASE_URL first, so links in messages are right." };
    if (!v.checks.stripeRemindersOff?.done) return { ok: false, error: "Turn off Stripe's own reminder emails first, and tick it on the checklist (clients would get two reminders)." };
  }
  v.noticesOn = on;
  await write(v);
  await writeAudit({ actorId: actor.id, action: on ? "notices_turned_on" : "notices_turned_off", entity: "Setting", entityId: KEY });
  return { ok: true };
}

export async function setCardFee(i: { enabled: boolean; ratePercent: number; excludedStates: string[] }): Promise<ActionResult> {
  const actor = await superAdmin();
  if (!actor) return FORBIDDEN;
  const rateBasisPoints = Math.round(i.ratePercent * 100);
  if (!Number.isFinite(i.ratePercent) || rateBasisPoints < 0 || rateBasisPoints > 300) return { ok: false, error: "The rate must be between 0% and 3%." };
  const states = [...new Set(i.excludedStates.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (states.some((s) => !/^[A-Z]{2}$/.test(s))) return { ok: false, error: "Use two-letter state codes, e.g. CT, MA." };
  if (i.enabled) {
    const v = await read();
    const ace = await aceWithoutStart();
    if (ace.length) return { ok: false, error: `Give every ACE client a start date first (${names(ace)}).` };
    if (!v.checks.surchargeConfirmed?.done) return { ok: false, error: "Confirm card surcharge registration and state rules first, and tick it on the checklist." };
    if (!v.checks.clientsNotified?.done) return { ok: false, error: "Give existing card-paying clients notice of the fee first, and tick it on the checklist." };
  }
  const before = await getFeeSettings();
  const value = { enabled: i.enabled, rateBasisPoints, excludedStates: states };
  await db.setting.upsert({ where: { key: "cardFee" }, create: { key: "cardFee", value }, update: { value } });
  await writeAudit({ actorId: actor.id, action: "card_fee_settings", entity: "Setting", entityId: "cardFee", before, after: value });
  return { ok: true };
}

/**
 * Super Admin: copies past Stripe invoices into the portal (read-only in Stripe; safe to run again), so Reports
 * have history. Same as scripts/backfill-invoices.ts, without needing a terminal. Ticks the checklist item.
 */
export async function loadInvoiceHistory(since: string, deps: { stripe?: import("stripe").default } = {}): Promise<ActionResult<{ summary: string }>> {
  const actor = await superAdmin();
  if (!actor) return FORBIDDEN;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(new Date(since).getTime())) return { ok: false, error: "Enter the start date as YYYY-MM-DD." };
  const { backfillInvoices } = await import("@/stripe/backfill");
  const { fillInvoiceSubscriptions } = await import("@/clients/invoiceSubscriptions");
  const stripe = deps.stripe ?? (await import("@/stripe/client")).getStripe();
  const r = await backfillInvoices(stripe, new Date(since));
  // Clients with several packages: record which subscription each copied invoice billed.
  await fillInvoiceSubscriptions(2000, stripe);
  const summary = `${r.stored} invoices copied since ${since} (${r.seen} seen; ${r.skipped} skipped: ACE, one-off or not a client yet); ${r.clientsAdded} former clients added.`;
  const v = await read();
  v.checks.historyLoaded = { done: true, by: actor.id, byName: actor.name, at: new Date().toISOString() };
  await write(v);
  await writeAudit({ actorId: actor.id, action: "invoice_history_loaded", entity: "Setting", entityId: KEY, after: { since, ...r } });
  return { ok: true, summary };
}
