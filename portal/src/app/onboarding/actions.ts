"use server";

import { revalidatePath } from "next/cache";
import { startOnboarding, waiveOnboardingFee } from "@/onboarding/start";

export type StartFormResult = { ok?: boolean; error?: string; url?: string };
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const centsOrNull = (v: FormDataEntryValue | null) => (str(v) ? Math.round(Number(str(v).replace(/[$,]/g, "")) * 100) : null);

export async function startOnboardingAction(_: StartFormResult, f: FormData): Promise<StartFormResult> {
  const r = await startOnboarding({
    name: str(f.get("name")),
    email: str(f.get("email")),
    phone: str(f.get("phone")) || null,
    type: f.get("type") === "ACE" ? "ACE" : "DIRECT",
    packageId: str(f.get("packageId")) || null,
    customMonthlyCents: centsOrNull(f.get("customMonthly")),
    onboardingFeeCents: centsOrNull(f.get("onboardingFee")),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/onboarding");
  return { ok: true, url: r.url };
}

export async function waiveFeeAction(_: StartFormResult, f: FormData): Promise<StartFormResult> {
  const r = await waiveOnboardingFee(String(f.get("onboardingId") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath("/onboarding");
  return { ok: true };
}
