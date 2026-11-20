import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contractVersion, renderContract, contractFileFor } from "@/domain/contract";

const files = ["essentials", "growth", "enterprise", "enterprise-custom"];
const values = {
  date: "November 20, 2026", client_name: "Acme LLC", client_first_name: "Jane", phone: "555", address1: "1 Main",
  address2: "", city: "Austin", state: "TX", zip: "78701", signer_name: "Jane Doe", onboarding_fee: "$500.00", monthly_amount: "$650.00",
};

describe("renderContract", () => {
  it.each(files)("fills every placeholder in %s.txt", (f) => {
    const t = readFileSync(`contracts/${f}.txt`, "utf8");
    const r = renderContract(t, values, { checks: { confirm_details: true, agree_autopay: true }, choices: { quickbooks: 0 }, signatures: { client: "Jane Doe" } });
    expect(r.text).not.toMatch(/\{\{/);
    expect(r.text).toContain("Acme LLC");
    expect(r.text).toContain("[x] I can confirm");
    expect(r.text).toContain("(•) I have a QuickBooks Online Account Currently.");
    expect(r.text).toContain("( ) I do not have a QuickBooks Account");
    expect(r.text).toMatch(/Signed electronically by Jane Doe/);
    expect(r.text).toMatch(/Awaiting countersignature/);
    expect(r.missing).toEqual([]);
  });
  it("lists empty required fields (address2 is optional)", () => {
    const r = renderContract("{{client_name}} {{address2}} {{city}} {{check:agree_autopay}}", { client_name: "A", address2: "", city: "" });
    expect(r.missing).toEqual(["city"]);
    expect(r.text).toContain("[ ]");
  });
  it("versions templates and leaves a signed copy unchanged when the template is edited", () => {
    const t1 = "Hello {{client_name}}";
    const signed = renderContract(t1, { client_name: "A" }).text;
    const t2 = "Hi {{client_name}}";
    expect(contractVersion(t1)).toHaveLength(12);
    expect(contractVersion(t1)).not.toBe(contractVersion(t2));
    expect(signed).toBe("Hello A");
  });
  it("maps package names to contract files", () => {
    expect(contractFileFor("Essentials")).toBe("essentials.txt");
    expect(contractFileFor("Growth Package")).toBe("growth.txt");
    expect(contractFileFor("Enterprise")).toBe("enterprise.txt");
    expect(contractFileFor("Enterprise Custom")).toBe("enterprise-custom.txt");
    expect(contractFileFor("Custom")).toBe("enterprise-custom.txt");
    expect(contractFileFor("Other")).toBeNull();
  });
});
