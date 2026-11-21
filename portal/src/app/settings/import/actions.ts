"use server";

import { revalidatePath } from "next/cache";
import { applyImport, planImport, type Problem, type ReadyRow } from "@/migration/commissionImport";

export type ImportState = { csv?: string; create?: boolean; addClients?: boolean; settled?: string; ready?: ReadyRow[]; problems?: Problem[]; applied?: number; failed?: Problem[]; error?: string };

async function readCsv(f: FormData): Promise<string> {
  const file = f.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > 2_000_000) throw new Error("That file is too big (2 MB max).");
    return file.text();
  }
  return String(f.get("csv") ?? "");
}

export async function importAction(prev: ImportState, f: FormData): Promise<ImportState> {
  try {
    const step = String(f.get("step") ?? "preview");
    const create = f.get("create") === "on";
    const addClients = f.get("addClients") === "on";
    const settled = String(f.get("settled") ?? "").trim() || undefined;
    const csv = step === "apply" ? String(f.get("csv") ?? "") : await readCsv(f);
    if (!csv.trim()) return { error: "Choose a CSV file (or paste the rows)." };
    const plan = await planImport(csv, { createMissingExecutives: create, settledThrough: settled, createMissingClients: addClients });
    if (plan.error) return { csv, create, addClients, settled, error: plan.error };
    if (step !== "apply") return { csv, create, addClients, settled, ...plan };
    // Re-checked at apply time, so a change since the preview can't sneak in.
    const res = await applyImport(plan.ready);
    revalidatePath("/commissions");
    return { csv, create, addClients, settled, problems: plan.problems, applied: res.applied, failed: res.failed };
  } catch (e) {
    return { error: (e as Error).message.startsWith("Forbidden") ? "You don't have permission to do that." : (e as Error).message };
  }
}
