import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";
import { DEFAULT_INTAKE_QUESTIONS, isAnswerable, parseIntakeQuestions } from "@/domain/intake";

export * from "@/domain/intake";

export type OnboardingSettings = {
  intakeQuestions: string;
  /** User id of the person who countersigns contracts (Jose). Empty = the first Owner. */
  countersignerUserId: string;
  /** GHL booking link for the onboarding call. */
  calendarUrl: string;
  /** The GHL calendar's ID: the portal checks it for each new client's booked call. Empty = no sync. */
  ghlCalendarId: string;
  /** Days unpaid after the first failed charge before a client is suspended. */
  suspendAfterDays: number;
  /** Office copy of every fully signed agreement (empty = none). */
  contractCopyEmail: string;
};

export const DEFAULT_ONBOARDING_SETTINGS: OnboardingSettings = {
  intakeQuestions: DEFAULT_INTAKE_QUESTIONS,
  countersignerUserId: "",
  calendarUrl: "",
  ghlCalendarId: "",
  suspendAfterDays: 30,
  contractCopyEmail: "info@book-clarity.com",
};

export async function getOnboardingSettings(): Promise<OnboardingSettings> {
  const row = await db.setting.findUnique({ where: { key: "onboarding" } });
  return { ...DEFAULT_ONBOARDING_SETTINGS, ...((row?.value as Partial<OnboardingSettings> | null) ?? {}) };
}

/** The person who countersigns: the configured user if still an Owner/Super Admin, else the first Owner. */
export async function getCountersigner() {
  const s = await getOnboardingSettings();
  if (s.countersignerUserId) {
    const u = await db.user.findUnique({ where: { id: s.countersignerUserId } });
    if (u && u.role !== "ADMIN") return u;
  }
  return db.user.findFirst({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" } });
}

/** Owners: the questionnaire, who countersigns, the onboarding-call booking link, and when unpaid clients are suspended. */
export async function saveOnboardingSettings(i: Omit<OnboardingSettings, "contractCopyEmail" | "ghlCalendarId"> & { contractCopyEmail?: string; ghlCalendarId?: string }): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  const parsed = parseIntakeQuestions(i.intakeQuestions);
  if (!parsed.some(isAnswerable)) return { ok: false, error: "Add at least one question." };
  const badIf = i.intakeQuestions.split("\n").map((l) => l.trim()).find((l, n, all) => /\|\s*if:/.test(l) && !parseIntakeQuestions(all.slice(0, n + 1).join("\n")).at(-1)?.showIf);
  if (badIf) return { ok: false, error: `This line's "if:" doesn't match an earlier question exactly: ${badIf.split("|")[0].trim()}` };
  const calendarUrl = i.calendarUrl.trim();
  if (calendarUrl && !/^https:\/\/\S+$/.test(calendarUrl)) return { ok: false, error: "The booking link must start with https://" };
  const ghlCalendarId = (i.ghlCalendarId ?? (await getOnboardingSettings()).ghlCalendarId).trim();
  if (ghlCalendarId && !/^[A-Za-z0-9_-]{8,64}$/.test(ghlCalendarId)) return { ok: false, error: "The GHL calendar ID should be letters and numbers only (GHL → Calendars → the calendar's settings)." };
  if (!Number.isInteger(i.suspendAfterDays) || i.suspendAfterDays < 7 || i.suspendAfterDays > 120) return { ok: false, error: "Suspend after must be between 7 and 120 days." };
  if (i.countersignerUserId) {
    const u = await db.user.findUnique({ where: { id: i.countersignerUserId } });
    if (!u || u.role === "ADMIN") return { ok: false, error: "The countersigner must be an Owner or the Super Admin." };
  }
  const copy = (i.contractCopyEmail ?? (await getOnboardingSettings()).contractCopyEmail).trim().toLowerCase();
  if (copy && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(copy)) return { ok: false, error: "Enter a valid email for signed-agreement copies, or leave it empty." };
  const value = { contractCopyEmail: copy, intakeQuestions: i.intakeQuestions.replace(/\r\n/g, "\n").trim(), countersignerUserId: i.countersignerUserId, calendarUrl, ghlCalendarId, suspendAfterDays: i.suspendAfterDays };
  const before = await getOnboardingSettings();
  await db.setting.upsert({ where: { key: "onboarding" }, create: { key: "onboarding", value }, update: { value } });
  await writeAudit({ actorId: actor.id, action: "onboarding_settings_saved", entity: "Setting", entityId: "onboarding", before, after: value });
  return { ok: true };
}
