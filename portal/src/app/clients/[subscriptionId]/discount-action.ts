"use server";

import { revalidatePath } from "next/cache";
import { applyDiscount } from "@/billing/discounts";
import { subscriptionRef } from "@/clients/subscriptions";

export type DiscountFormState = { ok?: boolean; error?: string };

/** Form wrapper around applyDiscount (which enforces discounts.apply on the server). */
export async function applyDiscountAction(_: DiscountFormState, form: FormData): Promise<DiscountFormState> {
  const subscriptionId = String(form.get("subscriptionId") ?? "");
  const client = (await subscriptionRef(subscriptionId))?.client ?? null;
  if (!client) return { error: "Client not found. Refresh the dashboard and try again." };

  const kind = form.get("kind") === "AMOUNT" ? "AMOUNT" : "PERCENT";
  const value = Number(form.get("value"));
  const months = Number(form.get("months"));
  const reason = String(form.get("reason") ?? "");
  const input =
    kind === "PERCENT"
      ? { kind, percentOff: value, months, reason }
      : { kind, amountOffCents: Math.round(value * 100), months, reason };

  const r = await applyDiscount(client.id, input as never, subscriptionId);
  if (!r.ok) return { error: r.error };
  revalidatePath(`/clients/${subscriptionId}`);
  return { ok: true };
}
