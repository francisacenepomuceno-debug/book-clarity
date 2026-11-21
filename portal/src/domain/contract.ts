import { createHash } from "node:crypto";

/** Fields a client may leave empty. */
const OPTIONAL = new Set(["address2"]);

export type ContractMarks = {
  checks?: Record<string, boolean>;
  choices?: Record<string, number>;
  signatures?: Record<string, string>;
  signedAt?: Record<string, string>;
};

/** Short version id of a template: the first 12 hex chars of its SHA-256. */
export function contractVersion(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Pure: fills a contract template. Checks, choices and signatures show their chosen/signed state. */
export function renderContract(
  template: string,
  values: Record<string, string>,
  marks: ContractMarks = {},
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{([^}]+)\}\}/g, (_, raw: string) => {
    const [head, ...rest] = raw.split("|");
    const [kind, name] = head.includes(":") ? head.split(":") : ["field", head];
    if (kind === "check") return marks.checks?.[name] ? "[x]" : "[ ]";
    if (kind === "choice") return rest.map((opt, i) => `${marks.choices?.[name] === i ? "(•)" : "( )"} ${opt}`).join("\n");
    if (kind === "signature") {
      const who = marks.signatures?.[name];
      if (who) return `Signed electronically by ${who}${marks.signedAt?.[name] ? ` on ${marks.signedAt[name]}` : ""}`;
      return name === "provider" ? "Awaiting countersignature by Book Clarity, LLC" : "Not yet signed";
    }
    const v = values[name] ?? "";
    if (!v.trim() && !OPTIONAL.has(name) && !missing.includes(name)) missing.push(name);
    return v;
  });
  return { text, missing };
}

/** Which repo template a package uses, by name. */
export function contractFileFor(packageName: string): string | null {
  const n = packageName.toLowerCase();
  if (n.includes("custom")) return "enterprise-custom.txt";
  if (n.includes("enterprise")) return "enterprise.txt";
  if (n.includes("growth")) return "growth.txt";
  if (n.includes("essential")) return "essentials.txt";
  return null;
}

/**
 * Pure: a package contract reworded for a client whose onboarding fee was waived (approved by Book Clarity,
 * 2026-11-21). Only the sentences about charging the fee and counting billing from its payment change.
 */
export function waivedFeeTemplate(template: string): string {
  return template
    .replace(
      "Your onboarding fee of {{onboarding_fee}} is charged when you sign up. Your first monthly retainer of {{monthly_amount}} is charged 14 days later, on your monthly billing date.",
      "Your onboarding fee has been waived. Your first monthly retainer of {{monthly_amount}} is charged 14 days after you sign up, on your monthly billing date.",
    )
    .replace(
      " for the onboarding fee invoice upon signing, in the amount of {{onboarding_fee}}, and to continue auto-debiting the amount of {{monthly_amount}} each month on my monthly billing date (14 days after the onboarding fee is paid) thereafter.",
      " in the amount of {{monthly_amount}} each month on my monthly billing date (14 days after signing) thereafter. The onboarding fee has been waived.",
    )
    .replaceAll("begins 14 days after the onboarding fee is paid", "begins 14 days after you sign up")
    .replaceAll("(14 days after the onboarding fee is paid)", "(14 days after signing)");
}
