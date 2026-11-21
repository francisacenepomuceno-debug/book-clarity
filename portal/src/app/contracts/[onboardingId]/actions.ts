"use server";

import { revalidatePath } from "next/cache";
import { countersign } from "@/onboarding/countersign";

export type CsResult = { error?: string };

export async function countersignAction(_: CsResult, f: FormData): Promise<CsResult> {
  const id = String(f.get("onboardingId") ?? "");
  const mode = String(f.get("sigMode") ?? "draw");
  const r = await countersign(id, new Date(), mode === "type" ? null : String(f.get("signatureImage") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath(`/contracts/${id}`);
  revalidatePath("/onboarding");
  return {};
}
