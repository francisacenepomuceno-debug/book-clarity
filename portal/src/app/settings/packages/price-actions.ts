"use server";

import { revalidatePath } from "next/cache";
import { cancelPriceIncrease, schedulePriceIncrease } from "@/billing/priceChanges";

export type PriceChangeFormState = { ok?: boolean; error?: string };

export async function schedulePriceIncreaseAction(_: PriceChangeFormState, f: FormData): Promise<PriceChangeFormState> {
  const dollars = Number(String(f.get("newMonthly") ?? "").replace(/[$,\s]/g, ""));
  const r = await schedulePriceIncrease({
    packageId: String(f.get("packageId") ?? ""),
    newMonthlyCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : NaN,
    startsOn: String(f.get("startsOn") ?? ""),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}

export async function cancelPriceIncreaseAction(_: PriceChangeFormState, f: FormData): Promise<PriceChangeFormState> {
  const r = await cancelPriceIncrease(String(f.get("priceChangeId") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}
