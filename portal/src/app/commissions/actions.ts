"use server";

import { revalidatePath } from "next/cache";
import { addExecutive, setClientCommission } from "@/commissions/splits";
import { markStatementPaid } from "@/commissions/statements";
import { startOfDayIn } from "@/domain/commission";
import { db } from "@/lib/db";

export type FormResult = { ok?: boolean; error?: string };
const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";

export async function addExecutiveAction(_: FormResult, form: FormData): Promise<FormResult> {
  const r = await addExecutive(String(form.get("name") ?? ""));
  if (!r.ok) return { error: r.error };
  revalidatePath("/commissions");
  return { ok: true };
}

export async function markPaidAction(_: FormResult, form: FormData): Promise<FormResult> {
  const paidOn = String(form.get("paidOn") ?? "");
  const r = await markStatementPaid(String(form.get("executiveId") ?? ""), String(form.get("month") ?? ""), startOfDayIn(paidOn, tz()));
  if (!r.ok) return { error: r.error };
  revalidatePath("/commissions");
  return { ok: true };
}

export async function setCommissionAction(_: FormResult, form: FormData): Promise<FormResult> {
  const subscriptionId = String(form.get("subscriptionId") ?? "");
  // The form key is the Stripe subscription id, or the portal client id for clients without one (ACE).
  const client = subscriptionId.startsWith("sub_")
    ? await db.client.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } })
    : await db.client.findUnique({ where: { id: subscriptionId }, select: { id: true } });
  if (!client) return { error: "Client not found. Refresh and try again." };
  const shares = [1, 2]
    .map((i) => ({ executiveId: String(form.get(`exec${i}`) ?? ""), ratePercent: Number(form.get(`rate${i}`)) }))
    .filter((s) => s.executiveId);
  const months = String(form.get("monthsBeforePortal") ?? "").trim();
  const r = await setClientCommission(client.id, {
    shares,
    effectiveFrom: startOfDayIn(String(form.get("effectiveFrom") ?? ""), tz()),
    monthsBeforePortal: months === "" ? undefined : Number(months),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${subscriptionId}`);
  revalidatePath("/commissions");
  return { ok: true };
}
