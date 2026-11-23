"use server";

import { revalidatePath } from "next/cache";
import { markPaidOutside, setPaysOutsideStripe } from "@/billing/outsidePayments";

export type OutsideFormState = { ok?: boolean; error?: string };

export async function markPaidOutsideAction(_: OutsideFormState, f: FormData): Promise<OutsideFormState> {
  const r = await markPaidOutside(String(f.get("invoiceId") ?? ""), {
    paidOn: String(f.get("paidOn") ?? ""),
    method: String(f.get("method") ?? ""),
    reference: String(f.get("reference") ?? ""),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/payments/outside");
  revalidatePath("/");
  return { ok: true };
}

export async function setPaysOutsideAction(_: OutsideFormState, f: FormData): Promise<OutsideFormState> {
  const on = f.get("on") === "on";
  const r = await setPaysOutsideStripe(String(f.get("clientId") ?? ""), on, String(f.get("method") ?? "") || null);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${String(f.get("pageKey") ?? "")}`);
  revalidatePath("/payments/outside");
  return { ok: true };
}
