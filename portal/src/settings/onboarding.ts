import { db } from "@/lib/db";

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
