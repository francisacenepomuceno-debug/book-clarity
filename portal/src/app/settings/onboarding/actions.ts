"use server";

import { revalidatePath } from "next/cache";
import { saveOnboardingSettings } from "@/settings/onboarding";

export type SettingsResult = { ok?: boolean; error?: string };

export async function saveOnboardingSettingsAction(_: SettingsResult, f: FormData): Promise<SettingsResult> {
  const r = await saveOnboardingSettings({
    intakeQuestions: String(f.get("intakeQuestions") ?? ""),
    countersignerUserId: String(f.get("countersignerUserId") ?? ""),
    calendarUrl: String(f.get("calendarUrl") ?? ""),
    suspendAfterDays: Number(f.get("suspendAfterDays")),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/onboarding");
  return { ok: true };
}
