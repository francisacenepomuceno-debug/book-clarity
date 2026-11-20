"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { choosePackage, confirmCallBooked, saveDetails, saveIntake, signContract, type Details } from "@/onboarding/steps";

export type StepResult = { error?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const back = (token: string) => redirect(`/onboard/${token}`);

export async function packageAction(_: StepResult, f: FormData): Promise<StepResult> {
  const token = str(f, "token");
  const r = await choosePackage(token, str(f, "packageId"));
  if (!r.ok) return { error: r.error };
  back(token);
  return {};
}

export async function detailsAction(_: StepResult, f: FormData): Promise<StepResult> {
  const token = str(f, "token");
  const keys: (keyof Details)[] = ["business", "firstName", "signerName", "phone", "address1", "address2", "city", "state", "zip"];
  const r = await saveDetails(token, Object.fromEntries(keys.map((k) => [k, str(f, k)])) as Details);
  if (!r.ok) return { error: r.error };
  back(token);
  return {};
}

export async function signAction(_: StepResult, f: FormData): Promise<StepResult> {
  const token = str(f, "token");
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  const qb = str(f, "quickbooks");
  const r = await signContract(token, {
    signerName: str(f, "signerName"),
    confirmDetails: f.get("confirmDetails") === "on",
    agreeAutopay: f.get("agreeAutopay") === "on",
    quickbooks: qb === "" ? null : Number(qb),
  }, ip);
  if (!r.ok) return { error: r.error };
  back(token);
  return {};
}

export async function intakeAction(_: StepResult, f: FormData): Promise<StepResult> {
  const token = str(f, "token");
  const answers: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (/^q\d+$/.test(k)) answers[k] = String(v);
  const r = await saveIntake(token, answers);
  if (!r.ok) return { error: r.error };
  back(token);
  return {};
}

export async function callBookedAction(_: StepResult, f: FormData): Promise<StepResult> {
  const token = str(f, "token");
  const r = await confirmCallBooked(token);
  if (!r.ok) return { error: r.error };
  redirect(`/setup-complete?onboarded=1`);
}
