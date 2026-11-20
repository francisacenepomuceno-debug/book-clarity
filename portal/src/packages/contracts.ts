import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Package } from "@prisma/client";
import { db } from "@/lib/db";
import { ForbiddenError, requirePermission } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { contractFileFor, contractVersion } from "@/domain/contract";
import type { ActionResult } from "@/billing/discounts";

const CONTRACTS_DIR = path.join(process.cwd(), "contracts");

/** The repo's default contract for a package (by name), or null. */
export async function defaultContractFor(packageName: string): Promise<string | null> {
  const file = contractFileFor(packageName);
  if (!file) return null;
  try {
    return await readFile(path.join(CONTRACTS_DIR, file), "utf8");
  } catch {
    return null;
  }
}

/** The contract a package uses now: its saved template, else the repo default for its name. */
export async function contractFor(pkg: Pick<Package, "name" | "contractTemplate">): Promise<{ template: string; version: string } | null> {
  const template = pkg.contractTemplate ?? (await defaultContractFor(pkg.name));
  return template ? { template, version: contractVersion(template) } : null;
}

/** Saves the repo default contract on every package that has none yet. Returns the names it filled. */
export async function loadDefaultContracts(): Promise<string[]> {
  const filled: string[] = [];
  for (const p of await db.package.findMany({ where: { contractTemplate: null } })) {
    const t = await defaultContractFor(p.name);
    if (!t) continue;
    await db.package.update({ where: { id: p.id }, data: { contractTemplate: t, contractVersion: contractVersion(t) } });
    filled.push(p.name);
  }
  return filled;
}

/** Owner: replaces a package's contract. Clients who already signed keep their signed copy. */
export async function saveContract(packageId: string, template: string): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission("ace.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: "You don't have permission to do that." };
    throw e;
  }
  const text = template.replace(/\r\n/g, "\n");
  if (!text.trim()) return { ok: false, error: "The contract can't be empty." };
  if (!text.includes("{{signature:client}}")) return { ok: false, error: "The contract needs a {{signature:client}} line for the client to sign." };
  const before = await db.package.findUnique({ where: { id: packageId } });
  if (!before) return { ok: false, error: "Package not found." };
  const version = contractVersion(text);
  await db.package.update({ where: { id: packageId }, data: { contractTemplate: text, contractVersion: version } });
  await writeAudit({ actorId: actor.id, action: "contract_saved", entity: "Package", entityId: packageId, before: { version: before.contractVersion }, after: { version } });
  return { ok: true };
}
