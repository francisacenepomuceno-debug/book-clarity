"use server";

import { revalidatePath } from "next/cache";
import { countersign } from "@/onboarding/countersign";

export type CsResult = { error?: string };

export async function countersignAction(_: CsResult, f: FormData): Promise<CsResult> {
  const id = String(f.get("onboardingId") ?? "");
  const r = await countersign(id);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/contracts/${id}`);
  revalidatePath("/onboarding");
  return {};
}
