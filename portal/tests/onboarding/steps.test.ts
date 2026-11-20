import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { onboardingLink } from "@/onboarding/start";
import { choosePackage, confirmCallBooked, loadOnboarding, saveDetails, saveIntake, signContract } from "@/onboarding/steps";
import { parseIntakeQuestions, DEFAULT_INTAKE_QUESTIONS } from "@/settings/onboarding";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));

const now = new Date("2026-11-20T15:00:00Z");
const details = { business: "Acme LLC", firstName: "Jane", signerName: "Jane Doe", phone: "555-0100", address1: "1 Main St", address2: "", city: "Austin", state: "TX", zip: "78701" };
const sign = { signerName: "jane doe", confirmDetails: true, agreeAutopay: true, quickbooks: 1 };
let token = "";
let pkgId = "";

async function setup(type: "DIRECT" | "ACE" = "DIRECT") {
  const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_g", contractTemplate: "Client {{client_name}} {{monthly_amount}} {{onboarding_fee}} by {{signer_name}}\n{{check:confirm_details}} ok\n{{choice:quickbooks|Have QBO|Need QBO}}\n{{signature:client}}\n{{signature:provider}}" } });
  pkgId = p.id;
  const c = await db.client.create({ data: { name: "Acme", email: "a@acme.co", type } });
  const o = await db.onboarding.create({ data: { clientId: c.id, ...(type === "ACE" ? { packageId: p.id, monthlyCents: 65000, onboardingFeeCents: 50000 } : {}) } });
  await db.client.update({ where: { id: c.id }, data: { packageId: type === "ACE" ? p.id : null } });
  token = onboardingLink(o.id, "https://p").split("/onboard/")[1];
  return o.id;
}

beforeEach(async () => {
  await resetDb();
  ghl.upsert.mockReset().mockResolvedValue("ct");
  ghl.send.mockReset().mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("client onboarding steps", () => {
  it("walks a Direct client from package to done, storing the signed text exactly", async () => {
    const id = await setup();
    await db.user.create({ data: { email: "jose@bc.test", name: "Jose", role: "OWNER" } });
    expect(await choosePackage(token, pkgId, now)).toEqual({ ok: true });
    expect(await saveDetails(token, details, now)).toEqual({ ok: true });
    expect(await signContract(token, sign, "203.0.113.9", now)).toEqual({ ok: true });
    const o = await db.onboarding.findUniqueOrThrow({ where: { id } });
    expect(o.signedText).toContain("Client Acme LLC $650.00 $500.00 by Jane Doe");
    expect(o.signedText).toContain("[x] ok");
    expect(o.signedText).toContain("( ) Have QBO\n(•) Need QBO");
    expect(o.signedText).toMatch(/Signed electronically by Jane Doe on /);
    expect(o.signedHash).toBe(createHash("sha256").update(o.signedText!).digest("hex"));
    expect(o).toMatchObject({ signerName: "Jane Doe", signerIp: "203.0.113.9", quickbooks: "Need QBO" });
    expect(o.contractVersion).toHaveLength(12);
    expect((await db.notification.findMany()).map((n) => n.key)).toContain(`countersign-request:${id}`);
    expect((await db.client.findUniqueOrThrow({ where: { id: o.clientId } })).name).toBe("Acme LLC");

    // payment comes next; a later step can't be done first
    expect((await loadOnboarding(token)).step).toBe("payment");
    expect((await saveIntake(token, { q0: "x" }, now)).ok).toBe(false);
    await db.onboarding.update({ where: { id }, data: { feePaidAt: now } });
    await db.setting.create({ data: { key: "onboarding", value: { intakeQuestions: "Industry | text | required\nWebsite? | yesno\nURL | text | required | if: Website? = YES" } } });
    expect((await saveIntake(token, { q0: "", q1: "NO" }, now)).ok).toBe(false); // required
    expect(await saveIntake(token, { q0: "Retail", q1: "NO", q2: "hidden.example" }, now)).toEqual({ ok: true });
    expect((await db.onboarding.findUniqueOrThrow({ where: { id } })).intake).toEqual([
      { question: "Industry", answer: "Retail" },
      { question: "Website?", answer: "NO" },
    ]);
    expect(await confirmCallBooked(token, now)).toEqual({ ok: true });
    expect((await db.onboarding.findUniqueOrThrow({ where: { id } })).completedAt).toEqual(now);
  });

  it("refuses a tampered link and a finished onboarding", async () => {
    const id = await setup();
    expect("error" in (await loadOnboarding(token + "x"))).toBe(true);
    expect((await choosePackage(token + "x", pkgId, now)).ok).toBe(false);
    await db.onboarding.update({ where: { id }, data: { completedAt: now } });
    expect((await choosePackage(token, pkgId, now)).ok).toBe(false);
    const l = await loadOnboarding(token);
    expect("error" in l ? l.error : "").toMatch(/already complete/);
  });

  it("a client can't skip a step", async () => {
    await setup();
    expect((await saveDetails(token, details, now)).ok).toBe(false);
    expect((await signContract(token, sign, "ip", now)).ok).toBe(false);
  });

  it("signing needs both boxes, a QuickBooks answer, and the signer's own name", async () => {
    await setup();
    await choosePackage(token, pkgId, now);
    await saveDetails(token, details, now);
    expect((await signContract(token, { ...sign, agreeAutopay: false }, "ip", now)).ok).toBe(false);
    expect((await signContract(token, { ...sign, confirmDetails: false }, "ip", now)).ok).toBe(false);
    expect((await signContract(token, { ...sign, quickbooks: null }, "ip", now)).ok).toBe(false);
    expect((await signContract(token, { ...sign, signerName: "Someone Else" }, "ip", now)).ok).toBe(false);
  });

  it("details need the required fields", async () => {
    await setup();
    await choosePackage(token, pkgId, now);
    expect((await saveDetails(token, { ...details, city: "" }, now)).ok).toBe(false);
  });

  it("ACE clients go straight to details and skip payment", async () => {
    await setup("ACE");
    expect((await loadOnboarding(token)).step).toBe("details");
    await saveDetails(token, details, now);
    await signContract(token, sign, "ip", now);
    expect((await loadOnboarding(token)).step).toBe("intake");
  });

  it("intake defaults parse", () => {
    const qs = parseIntakeQuestions(DEFAULT_INTAKE_QUESTIONS);
    expect(qs.length).toBeGreaterThan(5);
    expect(parseIntakeQuestions("Industry? | choice:Retail,Services\nNotes | long\nAny staff? | yesno\nPlain")).toEqual([
      { label: "Industry?", kind: "choice", options: ["Retail", "Services"], required: false, showIf: null },
      { label: "Notes", kind: "long", options: [], required: false, showIf: null },
      { label: "Any staff?", kind: "yesno", options: [], required: false, showIf: null },
      { label: "Plain", kind: "text", options: [], required: false, showIf: null },
    ]);
  });
});
