"use server";

import { revalidatePath } from "next/cache";
import { setCardFee, setManualCheck, setNoticesOn, type CheckKey } from "@/settings/launch";

export type LaunchResult = { ok?: boolean; error?: string };
const done = (r: { ok: boolean; error?: string }): LaunchResult => {
  revalidatePath("/settings/launch");
  return r.ok ? { ok: true } : { error: r.error };
};

export async function checkAction(_: LaunchResult, f: FormData): Promise<LaunchResult> {
  return done(await setManualCheck(String(f.get("key")) as CheckKey, f.get("done") === "1"));
}
export async function noticesAction(_: LaunchResult, f: FormData): Promise<LaunchResult> {
  return done(await setNoticesOn(f.get("on") === "1"));
}
export async function cardFeeAction(_: LaunchResult, f: FormData): Promise<LaunchResult> {
  return done(
    await setCardFee({
      enabled: f.get("enabled") === "1",
      ratePercent: Number(f.get("rate")),
      excludedStates: String(f.get("states") ?? "").split(/[\s,]+/).filter(Boolean),
    }),
  );
}
