import { describe, expect, it } from "vitest";
import { DEFAULT_INTAKE_QUESTIONS, checkIntake, isShown, parseIntakeQuestions } from "@/settings/onboarding";

describe("questionnaire with show/hide logic", () => {
  const qs = parseIntakeQuestions([
    "Do you have a business website? | yesno | required",
    "Website | text | if: Do you have a business website? = YES",
    "Business Structure | choice: Sole Proprietorship; Corporation (C-Corp, S-Corp); Other (please specify): | required",
    "Other structure | text | required | if: Business Structure = Other (please specify):",
    "Bank Transactions | number | required",
  ].join("\n"));

  it("parses type, required, options with commas, and the show-if rule", () => {
    expect(qs[2]).toEqual({ label: "Business Structure", kind: "choice", options: ["Sole Proprietorship", "Corporation (C-Corp, S-Corp)", "Other (please specify):"], required: true, showIf: null });
    expect(qs[1]).toEqual({ label: "Website", kind: "text", options: [], required: false, showIf: { question: 0, equals: "YES" } });
    expect(qs[3].showIf).toEqual({ question: 2, equals: "Other (please specify):" });
    expect(qs[4].kind).toBe("number");
  });

  it("old-style lines still work", () => {
    expect(parseIntakeQuestions("Industry? | choice:Retail,Services\nNotes | long")).toEqual([
      { label: "Industry?", kind: "choice", options: ["Retail", "Services"], required: false, showIf: null },
      { label: "Notes", kind: "long", options: [], required: false, showIf: null },
    ]);
  });

  it("a follow-up shows only for the matching answer", () => {
    expect(isShown(qs, 1, { q0: "YES" })).toBe(true);
    expect(isShown(qs, 1, { q0: "NO" })).toBe(false);
  });

  it("required questions must be answered only when shown; hidden answers are dropped", () => {
    expect(checkIntake(qs, { q0: "NO", q2: "Sole Proprietorship", q4: "40" })).toEqual({
      ok: true,
      answers: [
        { question: "Do you have a business website?", answer: "NO" },
        { question: "Business Structure", answer: "Sole Proprietorship" },
        { question: "Bank Transactions", answer: "40" },
      ],
    });
    expect(checkIntake(qs, { q0: "NO", q1: "stale.com", q2: "Other (please specify):", q4: "40" })).toEqual({ ok: false, error: 'Please answer "Other structure".' });
    expect(checkIntake(qs, { q0: "YES", q2: "Sole Proprietorship", q4: "forty" })).toEqual({ ok: false, error: '"Bank Transactions" must be a number.' });
    expect(checkIntake(qs, { q0: "YES", q2: "Made up", q4: "1" })).toEqual({ ok: false, error: 'Please choose one of the options for "Business Structure".' });
  });

  it("the default questionnaire mirrors the live intake form, including its follow-ups", () => {
    const d = parseIntakeQuestions(DEFAULT_INTAKE_QUESTIONS);
    const label = (s: string) => d.findIndex((q) => q.label.startsWith(s));
    const follow = (child: string, parent: string, value: string) => expect(d[label(child)].showIf).toEqual({ question: label(parent), equals: value });
    follow("Website", "Do you have a business website?", "YES");
    follow("Other business structure", "Business Structure", "Other (please specify):");
    follow("How much revenue", "Do you have another business?", "YES");
    follow("Other fiscal year end", "Fiscal Year End", "Other");
    follow("Other accounting software", "Current Accounting Software", "Other (please specify):");
    follow("Number of existing loans", "Do you have existing loans or lines of credit?", "YES");
    follow("Specify the months", "Are there any high-volume transaction periods?", "YES");
    follow("Specify payroll software", "Payroll Software", "Other (please specify):");
    follow("Specify employee benefits", "Do you provide employee benefits?", "YES");
    follow("Specify the reports needed", "Types of Reports Needed", "Custom Reports (please specify):");
    follow("Specify your financial goals", "Do you have any specific financial goals or challenges?", "YES");
    follow("Payor name", "Is the payor the same as the contact person?", "NO");
    follow("Payor email", "Is the payor the same as the contact person?", "NO");
    expect(d.every((q) => q.showIf === null || q.showIf.question < d.indexOf(q))).toBe(true);
  });
});
