"use server";

import { revalidatePath } from "next/cache";
import { resumeClient } from "@/billing/suspension";

export type ResumeResult = { error?: string };

export async function resumeClientAction(_: ResumeResult, f: FormData): Promise<ResumeResult> {
  const r = await resumeClient(String(f.get("clientId") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath("/clients/[subscriptionId]", "page");
  return {};
}
