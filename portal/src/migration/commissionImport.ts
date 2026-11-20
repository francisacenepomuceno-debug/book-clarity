import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { validateSplit } from "@/domain/commission";
import { setClientCommission } from "@/commissions/splits";
import { assignSlot } from "@/ace/slots";
import { writeAudit } from "@/audit/log";

/** The columns Book Clarity fills in (one row per client). Download from the import page. */
export const IMPORT_TEMPLATE = [
  "client,type,executive_1,rate_1,executive_2,rate_2,months_already_earned,effective_from,ace_batch,ace_start_date",
  "Acme LLC,Direct,Jose,10%,,,4,,,",
  "ops@example.com,Direct,Jose,5%,Albert,5%,0,,,",
  "cus_ABC123,ACE,Albert,10%,,,0,,Spring 2026 batch,2026-03-10",
].join("\n");

const ALIASES: Record<string, string> = {
  client: "client", "client name": "client", name: "client", customer: "client", email: "client", "client email": "client", "stripe customer": "client",
  type: "type", "client type": "type", "direct/ace": "type",
  executive: "executive_1", "executive 1": "executive_1", executive_1: "executive_1", owner: "executive_1", "owner 1": "executive_1", owner_1: "executive_1",
  rate: "rate_1", "rate 1": "rate_1", rate_1: "rate_1", "commission %": "rate_1", commission: "rate_1",
  "executive 2": "executive_2", executive_2: "executive_2", "owner 2": "executive_2", owner_2: "executive_2",
  "rate 2": "rate_2", rate_2: "rate_2", "commission 2 %": "rate_2",
  months_already_earned: "months_already_earned", "months already earned": "months_already_earned", "months earned": "months_already_earned", "months paid": "months_already_earned",
  effective_from: "effective_from", "effective from": "effective_from",
  ace_batch: "ace_batch", "ace batch": "ace_batch", batch: "ace_batch",
  ace_start_date: "ace_start_date", "ace start date": "ace_start_date", "start date": "ace_start_date",
};

/** RFC 4180 CSV → rows keyed by canonical column names (header aliases accepted, unknown columns ignored). */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); records.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); records.push(row); }
  const [header = [], ...body] = records;
  const canonical = (h: string) => {
    const k = h.trim().toLowerCase().replace(/\s+/g, " ");
    return ALIASES[k] ?? ALIASES[k.replace(/_/g, " ")] ?? ALIASES[k.replace(/ /g, "_")] ?? null;
  };
  const keys = header.map(canonical);
  return body
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => {
      const o: Record<string, string> = {};
      keys.forEach((k, i) => { if (k && r[i]?.trim()) o[k] = r[i].trim(); });
      return o;
    });
}

/** "10", "10%", "0.10" → 10 (a value of 0.30 or less with a decimal point is read as a fraction). */
function percent(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace("%", "").trim());
  if (!Number.isFinite(n)) return NaN;
  return !v.includes("%") && v.includes(".") && n > 0 && n <= 0.3 ? Math.round(n * 10000) / 100 : n;
}

export type ReadyRow = {
  line: number;
  clientId: string;
  clientName: string;
  type: "DIRECT" | "ACE" | null;
  shares: { executiveName: string; ratePercent: number }[];
  newExecutives: string[];
  monthsBeforePortal: number | undefined;
  effectiveFrom: Date;
  ace: { batchId: string; packageId: string; startOn: string } | null;
};
export type Problem = { line: number; client: string; error: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Owners: checks every row and matches it to a client. Nothing is changed. */
export async function planImport(text: string, opts: { createMissingExecutives: boolean }): Promise<{ ready: ReadyRow[]; problems: Problem[] }> {
  await requirePermission("ace.manage");
  const rows = parseCsv(text);
  const [clients, execs, batches, freeSlots] = await Promise.all([
    db.client.findMany({ include: { package: true } }),
    db.executive.findMany({ where: { active: true } }),
    db.aceBatch.findMany(),
    db.aceSlot.findMany({ where: { clientId: null }, select: { batchId: true, packageId: true } }),
  ]);
  const execByName = new Map(execs.map((e) => [norm(e.name), e]));
  const free = new Map<string, number>();
  for (const s of freeSlots) free.set(`${s.batchId}:${s.packageId}`, (free.get(`${s.batchId}:${s.packageId}`) ?? 0) + 1);

  const ready: ReadyRow[] = [];
  const problems: Problem[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const key = r.client ?? "";
    const fail = (error: string) => problems.push({ line, client: key, error });
    if (!key) return fail("The client column is empty.");

    const matches = key.startsWith("cus_")
      ? clients.filter((c) => c.stripeCustomerId === key)
      : key.includes("@")
        ? clients.filter((c) => c.email?.toLowerCase() === key.toLowerCase())
        : clients.filter((c) => norm(c.name) === norm(key));
    if (matches.length === 0) return fail("No client matches this name, email or Stripe customer ID. Fix it on the client page or in the sheet.");
    if (matches.length > 1) return fail(`More than one client matches "${key}". Use their email or Stripe customer ID (cus_…) instead.`);
    const client = matches[0];

    const typeRaw = (r.type ?? "").toLowerCase();
    const type = typeRaw === "" ? null : typeRaw === "direct" ? "DIRECT" : typeRaw === "ace" ? "ACE" : undefined;
    if (type === undefined) return fail(`Type must be Direct or ACE (got "${r.type}").`);

    const shares: ReadyRow["shares"] = [];
    const newExecutives: string[] = [];
    for (const n of [1, 2] as const) {
      const name = r[`executive_${n}`];
      const rate = percent(r[`rate_${n}`]);
      if (!name && rate === null) continue;
      if (!name || rate === null || Number.isNaN(rate)) return fail(`Executive ${n} needs both a name and a rate.`);
      if (!execByName.has(norm(name))) {
        if (!opts.createMissingExecutives) return fail(`"${name}" isn't an executive in the portal. Add them on the Commissions page, or tick "create missing executives".`);
        newExecutives.push(name.trim().replace(/\s+/g, " "));
      }
      shares.push({ executiveName: name.trim(), ratePercent: rate });
    }
    if (shares.length > 0) {
      const v = validateSplit(shares.map((s, j) => ({ executiveId: `x${j}:${norm(s.executiveName)}`, rateBp: Math.round(s.ratePercent * 100) })));
      if (!v.ok) return fail(v.error);
      if (new Set(shares.map((s) => norm(s.executiveName))).size !== shares.length) return fail("Each executive can appear only once.");
    }

    let monthsBeforePortal: number | undefined;
    if (r.months_already_earned !== undefined) {
      const m = Number(r.months_already_earned);
      if (!Number.isInteger(m) || m < 0 || m > 12) return fail("Months already earned must be a whole number from 0 to 12.");
      monthsBeforePortal = m;
    }
    if (shares.length === 0 && monthsBeforePortal !== undefined) return fail("Months already earned needs at least one executive and rate.");

    const effectiveOn = r.effective_from ?? "2000-01-01";
    if (!DATE.test(effectiveOn)) return fail("effective_from must be a date like 2025-01-31.");

    let ace: ReadyRow["ace"] = null;
    if (r.ace_batch || r.ace_start_date) {
      if (type !== "ACE" && !(type === null && client.type === "ACE")) return fail("ACE batch and start date are only for ACE clients.");
      if (!r.ace_batch || !r.ace_start_date || !DATE.test(r.ace_start_date)) return fail("ACE clients need both ace_batch and ace_start_date (YYYY-MM-DD).");
      if (client.aceSlotId) {
        ace = null; // already in a slot: leave it (re-running the import changes nothing)
      } else {
        const batch = batches.find((b) => norm(b.note ?? "") === norm(r.ace_batch!)) ?? batches.find((b) => b.purchasedAt.toISOString().slice(0, 10) === r.ace_batch);
        if (!batch) return fail(`No ACE batch is named "${r.ace_batch}". Use the batch's note or its purchase date.`);
        if (!client.packageId) return fail("Link this client to a package first, so the right ACE slot can be used.");
        const k = `${batch.id}:${client.packageId}`;
        if (!free.get(k)) return fail(`No free ${client.package?.name ?? "package"} slot left in batch "${r.ace_batch}".`);
        free.set(k, free.get(k)! - 1);
        ace = { batchId: batch.id, packageId: client.packageId, startOn: r.ace_start_date };
      }
    }

    ready.push({
      line,
      clientId: client.id,
      clientName: client.name,
      type,
      shares,
      newExecutives,
      monthsBeforePortal,
      effectiveFrom: new Date(`${effectiveOn}T00:00:00Z`),
      ace,
    });
  });
  return { ready, problems };
}

/** Owners: applies checked rows. Safe to run again: the same split date replaces itself and filled slots are left. */
export async function applyImport(rows: ReadyRow[]): Promise<{ applied: number; failed: Problem[] }> {
  const actor = await requirePermission("ace.manage");
  const failed: Problem[] = [];
  let applied = 0;
  for (const r of rows) {
    const fail = (error: string) => failed.push({ line: r.line, client: r.clientName, error });
    for (const name of r.newExecutives) {
      if (!(await db.executive.findFirst({ where: { name: { equals: name, mode: "insensitive" } } }))) {
        const e = await db.executive.create({ data: { name } });
        await writeAudit({ actorId: actor.id, action: "executive_added", entity: "Executive", entityId: e.id, after: { name, via: "import" } });
      }
    }
    if (r.type) await db.client.update({ where: { id: r.clientId }, data: { type: r.type } });
    if (r.shares.length) {
      const execs = await db.executive.findMany({ where: { active: true } });
      const id = (n: string) => execs.find((e) => norm(e.name) === norm(n))?.id;
      const res = await setClientCommission(r.clientId, {
        shares: r.shares.map((s) => ({ executiveId: id(s.executiveName) ?? "", ratePercent: s.ratePercent })),
        effectiveFrom: r.effectiveFrom,
        monthsBeforePortal: r.monthsBeforePortal,
      });
      if (!res.ok) { fail(res.error); continue; }
    }
    if (r.ace) {
      const res = await assignSlot({ batchId: r.ace.batchId, packageId: r.ace.packageId, clientId: r.clientId, startOn: r.ace.startOn, confirmSubscribed: true });
      if (!res.ok) { fail(`Commission saved, but the ACE slot wasn't assigned: ${res.error}`); continue; }
    }
    applied++;
  }
  await writeAudit({ actorId: actor.id, action: "commission_import_applied", entity: "Import", entityId: new Date().toISOString(), after: { applied, failed: failed.length } });
  return { applied, failed };
}
