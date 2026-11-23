"use server";

import { revalidatePath } from "next/cache";
import { renameClient, separateCompany } from "@/clients/companies";

export type CompanyFormState = { ok?: boolean; error?: string };

export async function separateCompanyAction(_: CompanyFormState, f: FormData): Promise<CompanyFormState> {
  const sub = String(f.get("subscriptionId") ?? "");
  const r = await separateCompany(sub, String(f.get("name") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${sub}`);
  revalidatePath("/");
  return { ok: true };
}

export async function renameClientAction(_: CompanyFormState, f: FormData): Promise<CompanyFormState> {
  const r = await renameClient(String(f.get("clientId") ?? ""), String(f.get("name") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${String(f.get("subscriptionId") ?? "")}`);
  revalidatePath("/");
  return { ok: true };
}
