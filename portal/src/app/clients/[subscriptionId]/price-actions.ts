"use server";

import { revalidatePath } from "next/cache";
import { linkClientPackage, revertToListPrice } from "@/billing/pricing";
import { clearLiveSnapshot } from "@/stripe/liveSnapshot";

export type PriceFormState = { ok?: boolean; error?: string; note?: string };

export async function linkPackageAction(_: PriceFormState, f: FormData): Promise<PriceFormState> {
  const clientId = String(f.get("clientId") ?? "");
  const packageId = String(f.get("packageId") ?? "") || null;
  const r = await linkClientPackage(clientId, packageId);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${String(f.get("subscriptionId") ?? "")}`);
  revalidatePath("/");
  return { ok: true };
}

export async function revertPriceAction(_: PriceFormState, f: FormData): Promise<PriceFormState> {
  const r = await revertToListPrice(String(f.get("clientId") ?? ""));
  if (!r.ok) return { error: r.error };
  clearLiveSnapshot();
  revalidatePath(`/clients/${String(f.get("subscriptionId") ?? "")}`);
  revalidatePath("/");
  return { ok: true, note: r.note };
}
