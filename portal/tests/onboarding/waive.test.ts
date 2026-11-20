import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { waiveOnboardingFee } from "@/onboarding/start";
import { contractPreview, loadOnboarding } from "@/onboarding/steps";
import { onboardingLink } from "@/onboarding/start";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "jose", email: "j@x.co", name: "Jose", role, totpEnabled: true }, twoFactorVerified: true });

beforeEach(async () => { await resetDb(); as("OWNER"); });

async function onboarding(o: Record<string, unknown> = {}) {
  const p = await db.package.create({ data: { name: "Growth", monthlyPriceCents: 65000, onboardingFeeCents: 50000, stripePriceId: "price_g", contractTemplate: "Fee {{onboarding_fee}} monthly {{monthly_amount}} {{signature:client}}" } });
  const c = await db.client.create({ data: { name: "Acme", email: "a@x.co", packageId: p.id } });
  return db.onboarding.create({ data: { clientId: c.id, packageId: p.id, monthlyCents: 65000, onboardingFeeCents: 50000, details: { business: "Acme" }, ...o } });
}

describe("waiving the onboarding fee", () => {
  it("Owners can waive it until it's paid; the agreement then shows it as waived", async () => {
    const o = await onboarding();
    expect(await waiveOnboardingFee(o.id)).toEqual({ ok: true });
    expect((await db.onboarding.findUniqueOrThrow({ where: { id: o.id } })).onboardingFeeCents).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "onboarding_fee_waived" } })).after).toMatchObject({ previousCents: 50000 });
    const l = await loadOnboarding(onboardingLink(o.id, "https://p").split("/onboard/")[1]);
    if ("error" in l) throw new Error(l.error);
    expect((await contractPreview(l))!.values.onboarding_fee).toBe("$0.00 (waived)");
  });

  it("can't waive a fee that's paid, being paid, or once the client is on a bank-or-card step with an invoice", async () => {
    const paid = await onboarding({ feePaidAt: new Date() });
    expect((await waiveOnboardingFee(paid.id)).ok).toBe(false);
    await resetDb();
    const sent = await onboarding({ feeInvoiceId: "in_1" });
    expect((await waiveOnboardingFee(sent.id)).ok).toBe(false);
  });

  it("Admins can't waive it", async () => {
    const o = await onboarding();
    as("ADMIN");
    expect((await waiveOnboardingFee(o.id)).ok).toBe(false);
  });
});
