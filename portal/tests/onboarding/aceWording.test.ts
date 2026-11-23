import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aceTemplate, renderContract } from "@/domain/contract";

const values = { date: "d", client_name: "Acme", client_first_name: "J", phone: "1", address1: "a", address2: "", city: "c", state: "TX", zip: "1", signer_name: "Jane Doe", onboarding_fee: "$0.00 (waived)", monthly_amount: "$350.00" };

describe("ACE contract wording (owner, 2026-11-23)", () => {
  it.each(["essentials", "growth", "enterprise", "enterprise-custom"])("%s: prepaid 6 months, nothing charged at signup, billing only after agreeing to continue", (f) => {
    const text = renderContract(aceTemplate(readFileSync(`contracts/${f}.txt`, "utf8")), values).text;
    expect(text).toContain("Your first 6 months of service, including onboarding, are prepaid through the ACE program");
    expect(text).toContain("Monthly billing begins only if you agree to continue after the ACE period ends and set up a payment method for auto-pay");
    expect(text).toContain("There is no onboarding fee and nothing is charged when you sign up. If you choose to continue after the ACE period, your monthly retainer of $350.00 is charged on your monthly billing date.");
    expect(text).toContain("I Jane Doe understand that my first 6 months of service are prepaid through the ACE program and that nothing will be charged to me now.");
    expect(text).not.toMatch(/onboarding fee of|onboarding fee is paid|onboarding fee invoice|14 days/);
    // The rest of the contract (grace period, restart clause) is unchanged.
    expect(text).toContain("within five days of your monthly billing date");
  });
});
