import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import type { ActionResult } from "@/billing/discounts";

export type IntakeQuestion = { label: string; kind: "text" | "long" | "yesno" | "choice"; options: string[] };

/** Draft questionnaire for Book Clarity's review; editable in Settings → Onboarding. */
export const DEFAULT_INTAKE_QUESTIONS = [
  "Legal business name",
  "Business type | choice:Sole proprietor,LLC (single member),LLC (multi member),S corporation,C corporation,Nonprofit,Other",
  "What does your business do? | long",
  "Industry",
  "Year the business started",
  "EIN (Employer Identification Number)",
  "Which bank(s) and credit card(s) does the business use? | long",
  "Number of business bank and credit card accounts",
  "Do you have employees or contractors? | yesno",
  "Which payroll provider do you use, if any?",
  "Do you collect sales tax? | yesno",
  "Last month your books were up to date",
  "Who prepares your tax return? (name and email)",
  "Anything else we should know before the onboarding call? | long",
].join("\n");

export type OnboardingSettings = {
  intakeQuestions: string;
  /** User id of the person who countersigns contracts (Jose). Empty = the first Owner. */
  countersignerUserId: string;
  /** GHL booking link for the onboarding call (until calendar sync, Plan 4C). */
  calendarUrl: string;
  /** Days unpaid after the first failed charge before a client is suspended. */
  suspendAfterDays: number;
};

export const DEFAULT_ONBOARDING_SETTINGS: OnboardingSettings = {
  intakeQuestions: DEFAULT_INTAKE_QUESTIONS,
  countersignerUserId: "",
  calendarUrl: "",
  suspendAfterDays: 30,
};

export async function getOnboardingSettings(): Promise<OnboardingSettings> {
  const row = await db.setting.findUnique({ where: { key: "onboarding" } });
  return { ...DEFAULT_ONBOARDING_SETTINGS, ...((row?.value as Partial<OnboardingSettings> | null) ?? {}) };
}

/** One question per line: `Question | text/long/yesno/choice:a,b` (type defaults to text). */
export function parseIntakeQuestions(text: string): IntakeQuestion[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, spec = "text"] = l.split("|").map((s) => s.trim());
      if (spec.startsWith("choice:")) return { label, kind: "choice" as const, options: spec.slice(7).split(",").map((s) => s.trim()).filter(Boolean) };
      const kind = spec === "long" || spec === "yesno" ? spec : "text";
      return { label, kind, options: [] };
    });
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
export async function saveOnboardingSettings(i: OnboardingSettings): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  if (parseIntakeQuestions(i.intakeQuestions).length === 0) return { ok: false, error: "Add at least one question." };
  const calendarUrl = i.calendarUrl.trim();
  if (calendarUrl && !/^https:\/\/\S+$/.test(calendarUrl)) return { ok: false, error: "The booking link must start with https://" };
  if (!Number.isInteger(i.suspendAfterDays) || i.suspendAfterDays < 7 || i.suspendAfterDays > 120) return { ok: false, error: "Suspend after must be between 7 and 120 days." };
  if (i.countersignerUserId) {
    const u = await db.user.findUnique({ where: { id: i.countersignerUserId } });
    if (!u || u.role === "ADMIN") return { ok: false, error: "The countersigner must be an Owner or the Super Admin." };
  }
  const value = { intakeQuestions: i.intakeQuestions.replace(/\r\n/g, "\n").trim(), countersignerUserId: i.countersignerUserId, calendarUrl, suspendAfterDays: i.suspendAfterDays };
  const before = await getOnboardingSettings();
  await db.setting.upsert({ where: { key: "onboarding" }, create: { key: "onboarding", value }, update: { value } });
  await writeAudit({ actorId: actor.id, action: "onboarding_settings_saved", entity: "Setting", entityId: "onboarding", before, after: value });
  return { ok: true };
}
