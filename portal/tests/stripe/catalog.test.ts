import { describe, expect, it } from "vitest";
import { classifyProduct } from "@/stripe/catalog";

describe("classifyProduct", () => {
  it.each([
    ["3% Credit Card Fee", { kind: "card_fee" }],
    ["3% Credit card fee", { kind: "card_fee" }],
    ["Essentials - Onboarding fee", { kind: "onboarding" }],
    ["Enterprise Custom Onboarding Fee", { kind: "onboarding" }],
    ["Monthly Essentials Package", { kind: "package", package: "Essentials", sixMonth: false }],
    ["Essential Package", { kind: "package", package: "Essentials", sixMonth: false }],
    ["Growth Package", { kind: "package", package: "Growth", sixMonth: false }],
    ["Growth 6 Months Contract", { kind: "package", package: "Growth", sixMonth: true }],
    ["Monthly Enterprise Package", { kind: "package", package: "Enterprise", sixMonth: false }],
    ["Monthly Enterprise Custom Package", { kind: "package", package: "Enterprise Custom", sixMonth: false }],
    ["AR/AP SCope", { kind: "other", name: "AR/AP SCope" }],
  ])("%s", (name, expected) => {
    expect(classifyProduct(name)).toEqual(expected);
  });
});
