import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderContract, waivedFeeTemplate } from "@/domain/contract";
import { stepLabel } from "@/domain/onboarding";

const values = { date: "d", client_name: "Acme", client_first_name: "J", phone: "1", address1: "a", address2: "", city: "c", state: "TX", zip: "1", signer_name: "Jane Doe", onboarding_fee: "$0.00 (waived)", monthly_amount: "$650.00" };

describe("waived onboarding fee wording", () => {
  it.each(["essentials", "growth", "enterprise", "enterprise-custom"])("%s: no fee charged at signup, billing counted from signing", (f) => {
    const text = renderContract(waivedFeeTemplate(readFileSync(`contracts/${f}.txt`, "utf8")), values).text;
    expect(text).toContain("Your onboarding fee has been waived. Your first monthly retainer of $650.00 is charged 14 days after you sign up, on your monthly billing date.");
    expect(text).toContain("begins 14 days after you sign up and recurs on that same date each month");
    expect(text).toContain("with Stripe in the amount of $650.00 each month on my monthly billing date (14 days after signing) thereafter. The onboarding fee has been waived.");
    expect(text).not.toMatch(/charged when you sign up|onboarding fee is paid|onboarding fee invoice/);
  });

  it("leaves an agreement with a fee untouched, and keeps the restart-fee clause", () => {
    const t = readFileSync("contracts/growth.txt", "utf8");
    expect(waivedFeeTemplate(t)).toMatch(/charge an additional onboarding fee/);
    expect(renderContract(t, { ...values, onboarding_fee: "$500.00" }).text).toContain("Your onboarding fee of $500.00 is charged when you sign up.");
  });

  it("the payment step is called 'Setting up autopay' when the fee is waived", () => {
    expect(stepLabel("payment", false)).toBe("Paying the onboarding fee");
    expect(stepLabel("payment", true)).toBe("Setting up autopay");
    expect(stepLabel("intake", true)).toBe("Filling in the questionnaire");
  });
});
