"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { savePackage } from "@/packages/packages";
import { saveContract } from "@/packages/contracts";
import { createBatch, issueBatchInvoice, recordBatchPayment, setAceContactEmail, setAceCustomer } from "@/ace/batches";
import { assignSlot } from "@/ace/slots";
import { markContinuing, markEnded } from "@/ace/continuation";
import { aceCardPayLink } from "@/ace/cardPay";

export type AceFormResult = { ok?: boolean; error?: string; setupUrl?: string; batchId?: string };
const cents = (v: FormDataEntryValue | null) => Math.round(Number(String(v ?? "").replace(/[$,]/g, "")) * 100);
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

export async function savePackageAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const r = await savePackage({
    id: str(f.get("id")) || undefined,
    name: str(f.get("name")),
    monthlyPriceCents: cents(f.get("monthly")),
    onboardingFeeCents: cents(f.get("onboarding")),
    isCustom: f.get("isCustom") === "on",
    stripePriceId: str(f.get("stripePriceId")) || null,
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}

export async function setAceCustomerAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const r = await setAceCustomer(str(f.get("customerId")));
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}

export async function createBatchAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const lines = [0, 1, 2, 3]
    .map((n) => ({ packageId: str(f.get(`pkg${n}`)), quantity: Number(f.get(`qty${n}`)), unitPriceCents: cents(f.get(`price${n}`)) }))
    .filter((l) => l.packageId);
  const paid = f.get("alreadyPaid") === "on";
  const historical = paid && f.get("historical") === "on";
  const r = await createBatch({
    purchasedOn: str(f.get("purchasedOn")),
    note: str(f.get("note")),
    lines,
    alreadyPaid: paid
      ? { paidOn: str(f.get("paidOn")), method: (str(f.get("method")) || "check") as "check", reference: str(f.get("reference")) }
      : undefined,
    historical,
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/ace");
  return { ok: true, batchId: r.batchId };
}

export async function recordPaymentAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const batchId = str(f.get("batchId"));
  const r = await recordBatchPayment(batchId, { paidOn: str(f.get("paidOn")), method: str(f.get("method")), reference: str(f.get("reference")) });
  if (!r.ok) return { error: r.error };
  revalidatePath(`/ace/${batchId}`);
  return { ok: true };
}

/** Assigns an existing client, or creates a new client by name first (new ACE clients aren't in Stripe yet). */
export async function assignSlotAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  await requirePermission("ace.manage");
  const batchId = str(f.get("batchId"));
  let clientId = str(f.get("clientId"));
  const newName = str(f.get("newName"));
  if (!clientId && newName) {
    clientId = (await db.client.create({ data: { name: newName, email: str(f.get("newEmail")) || null, type: "ACE", status: "ONBOARDING" } })).id;
  }
  if (!clientId) return { error: "Pick a client or enter a new client's name." };
  const custom = str(f.get("customMonthly"));
  const r = await assignSlot({
    batchId,
    packageId: str(f.get("packageId")),
    clientId,
    startOn: str(f.get("startOn")),
    customMonthlyCents: custom ? cents(custom) : undefined,
    confirmSubscribed: f.get("confirmSubscribed") === "on",
  });
  if (!r.ok) {
    if (newName) await db.client.deleteMany({ where: { id: clientId, aceSlotId: null } });
    return { error: r.error };
  }
  revalidatePath(`/ace/${batchId}`);
  return { ok: true };
}

export async function continueAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const r = await markContinuing(str(f.get("clientId")), base);
  if (!r.ok) return { error: r.error };
  revalidatePath("/ace");
  return { ok: true, setupUrl: r.setupUrl };
}

export async function endAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const r = await markEnded(str(f.get("clientId")));
  if (!r.ok) return { error: r.error };
  revalidatePath("/ace");
  return { ok: true };
}

export async function resendInvoiceAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const batchId = str(f.get("batchId"));
  const r = await issueBatchInvoice(batchId);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/ace/${batchId}`);
  return { ok: true };
}

export async function cardPayLinkAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const h = await headers();
  const base = process.env.PORTAL_BASE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const r = await aceCardPayLink(str(f.get("batchId")), base);
  if (!r.ok) return { error: r.error };
  return { ok: true, setupUrl: r.url };
}

export async function setAceContactAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const r = await setAceContactEmail(str(f.get("email")));
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}

export async function saveContractAction(_: AceFormResult, f: FormData): Promise<AceFormResult> {
  const r = await saveContract(str(f.get("packageId")), String(f.get("template") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/packages");
  return { ok: true };
}
