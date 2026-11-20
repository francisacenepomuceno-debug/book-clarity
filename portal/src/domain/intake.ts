/** Pure questionnaire logic, shared by the server and the client's browser. */

export type IntakeKind = "text" | "long" | "number" | "yesno" | "choice" | "heading" | "note";
export type IntakeQuestion = {
  label: string;
  kind: IntakeKind;
  options: string[];
  required: boolean;
  /** Shown only when an earlier question (by position) has exactly this answer. */
  showIf: { question: number; equals: string } | null;
};

/**
 * Mirrors Book Clarity's live GHL "Client Intake Form for BC" (intro.book-clarity.com/client-intake-landing-page),
 * including its show/hide follow-ups. Questions the portal already asks in earlier steps are left out:
 * business name and address, contact name/phone/email, services (package), payment method and the 3% notice,
 * and the signature (the agreement).
 */
export const DEFAULT_INTAKE_QUESTIONS = [
  "## Business details",
  "Job Title | text | required",
  "Do you have a business website? | yesno | required",
  "Website | text | required | if: Do you have a business website? = YES",
  "Business Structure (if multiple, choose Other and specify) | choice: Sole Proprietorship; Partnership; Limited Liability Company (LLC); Corporation (C-Corp, S-Corp); Non-Profit; Other (please specify): | required",
  "Other business structure (please specify) | text | required | if: Business Structure (if multiple, choose Other and specify) = Other (please specify):",
  "Industry | text | required",
  "Year Established | number | required",
  "Business EIN (Employer Identification Number) | text | required",
  "State of Incorporation | text | required",
  "Do you have another business? | yesno | required",
  "How much revenue does your other business make? | text | required | if: Do you have another business? = YES",
  "## Financial information",
  "Fiscal Year End | choice: December 31st; May 31st; Other | required",
  "Other fiscal year end date | text | required | if: Fiscal Year End = Other",
  "Accounting Method | choice: Cash Basis; Accrual Basis; Don't Know | required",
  "Current Accounting Software | choice: QuickBooks; Xero; FreshBooks; Wave; Other (please specify):; None | required",
  "Other accounting software (please specify) | text | required | if: Current Accounting Software = Other (please specify):",
  "Do you need assistance with accounting software setup or transition? | yesno | required",
  "## Current financial situation",
  "> Which current financial statements do you have available?",
  "Balance Sheet available? | yesno | required",
  "Income Statement (Profit & Loss) available? | yesno | required",
  "Cash Flow Statement available? | yesno | required",
  "Previous Tax Returns available? | yesno | required",
  "Number of Bank Accounts | number | required",
  "Number of Credit Card Accounts | number | required",
  "Do you have existing loans or lines of credit? | yesno | required",
  "Number of existing loans or lines of credit | number | required | if: Do you have existing loans or lines of credit? = YES",
  "## Transaction information",
  "Average number of monthly bank transactions | number | required",
  "Average number of monthly credit card transactions | number | required",
  "Are there any high-volume transaction periods? | yesno | required",
  "Specify the months with high volume | text | required | if: Are there any high-volume transaction periods? = YES",
  "## Payroll information",
  "Number of Employees | number | required",
  "Number of 1099 contractors | number | required",
  "Frequency of Payroll | choice: Weekly; Bi-Weekly; Semi-Monthly; Monthly; Daily; Multiple; No Payroll | required",
  "Payroll Software | choice: Gusto; ADP; Paychex; QuickBooks; Other (please specify):; None | required",
  "Specify payroll software used | text | required | if: Payroll Software = Other (please specify):",
  "Do you provide employee benefits? | yesno | required",
  "Specify employee benefits given | text | required | if: Do you provide employee benefits? = YES",
  "## Reporting needs",
  "Types of Reports Needed | choice: Monthly Financial Statements; Quarterly Financial Statements; Annual Financial Statements; Budget vs. Actual Reports; All of the above; Custom Reports (please specify): | required",
  "Specify the reports needed | text | required | if: Types of Reports Needed = Custom Reports (please specify):",
  "Frequency of Reports | choice: Weekly; Monthly; Quarterly; Annually | required",
  "## Additional information",
  "Do you have any specific financial goals or challenges? | yesno | required",
  "Specify your financial goals or challenges | long | required | if: Do you have any specific financial goals or challenges? = YES",
  "Preferred Method of Communication | choice: Email; Phone; Video Conferencing; In-Person Meetings | required",
  "Preferred Meeting Frequency | choice: Weekly; Monthly; Quarterly; As Needed | required",
  "## Billing",
  "Is the payor the same as the contact person? | yesno | required",
  "Payor name | text | required | if: Is the payor the same as the contact person? = NO",
  "Payor email | text | required | if: Is the payor the same as the contact person? = NO",
  "## Documents",
  "> Please have these ready for your onboarding call: previous year's tax returns; recent financial statements; bank and credit card statements (year to date); employee information (employee census).",
  "## Authorization and consent",
  "I authorize Book Clarity to access and review all necessary financial documents and information to provide the requested services. I confirm that the information provided in this form is accurate and complete to the best of my knowledge. | choice: I agree | required",
].join("\n");

/**
 * One question per line: `Question | type | required | if: Earlier question = Answer`.
 * Types: text (default), long, number, yesno, choice: A; B; C (commas also work when no option has one).
 * `## Heading` starts a section; `> text` shows a note. Answers to YES/NO questions are "YES" / "NO".
 */
export function parseIntakeQuestions(text: string): IntakeQuestion[] {
  const out: IntakeQuestion[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("## ")) { out.push({ label: l.slice(3).trim(), kind: "heading", options: [], required: false, showIf: null }); continue; }
    if (l.startsWith("> ")) { out.push({ label: l.slice(2).trim(), kind: "note", options: [], required: false, showIf: null }); continue; }
    const [label, ...parts] = l.split("|").map((s) => s.trim());
    const q: IntakeQuestion = { label, kind: "text", options: [], required: false, showIf: null };
    for (const part of parts) {
      if (part === "required") q.required = true;
      else if (part === "long" || part === "yesno" || part === "number" || part === "text") q.kind = part;
      else if (part.startsWith("choice:")) {
        const body = part.slice(7);
        q.kind = "choice";
        q.options = body.split(body.includes(";") ? ";" : ",").map((s) => s.trim()).filter(Boolean);
      } else if (part.startsWith("if:")) {
        const cond = part.slice(3);
        const eq = cond.indexOf("=");
        const parentLabel = cond.slice(0, eq).trim();
        const parent = out.findIndex((p) => p.label === parentLabel);
        if (eq > 0 && parent >= 0) q.showIf = { question: parent, equals: cond.slice(eq + 1).trim() };
      }
    }
    out.push(q);
  }
  return out;
}

export const isAnswerable = (q: IntakeQuestion) => q.kind !== "heading" && q.kind !== "note";

/** Whether question i is visible for these answers (a follow-up of a hidden question is hidden too). */
export function isShown(qs: IntakeQuestion[], i: number, answers: Record<string, string>): boolean {
  const c = qs[i].showIf;
  if (!c) return true;
  return isShown(qs, c.question, answers) && (answers[`q${c.question}`] ?? "").trim() === c.equals;
}

/** Validates the visible answers; hidden questions' answers are dropped. */
export function checkIntake(
  qs: IntakeQuestion[],
  answers: Record<string, string>,
): { ok: true; answers: { question: string; answer: string }[] } | { ok: false; error: string } {
  const out: { question: string; answer: string }[] = [];
  for (const [i, q] of qs.entries()) {
    if (!isAnswerable(q) || !isShown(qs, i, answers)) continue;
    const a = String(answers[`q${i}`] ?? "").trim();
    if (q.required && !a) return { ok: false, error: `Please answer "${q.label.length > 80 ? q.label.slice(0, 77) + "..." : q.label}".` };
    if (a && q.kind === "number" && !/^\d+(\.\d+)?$/.test(a.replace(/,/g, ""))) return { ok: false, error: `"${q.label}" must be a number.` };
    const opts = q.kind === "yesno" ? ["YES", "NO"] : q.options;
    if (a && (q.kind === "choice" || q.kind === "yesno") && !opts.includes(a)) return { ok: false, error: `Please choose one of the options for "${q.label}".` };
    out.push({ question: q.label, answer: a });
  }
  return { ok: true, answers: out };
}

