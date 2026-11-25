import { recalculateOpenCommission } from "@/commissions/engine";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { monthOf, packagePaidCents, startOfDayIn, validateSplit, windowMonthsFor } from "@/domain/commission";
import { setClientCommission } from "@/commissions/splits";
import { assignSlot } from "@/ace/slots";
import { writeAudit } from "@/audit/log";

/** The columns Book Clarity fills in (one row per client). Download from the import page. */
export const IMPORT_TEMPLATE = [
  "client,company,type,executive_1,rate_1,executive_2,rate_2,months_already_earned,effective_from,ace_batch,ace_start_date",
  "Acme LLC,Acme LLC,Direct,Jose,10%,,,4,,,",
  "ops@example.com,Ops Co,Direct,Jose,5%,Albert,5%,0,,,",
  "cus_ABC123,,ACE,Albert,10%,,,0,,Spring 2026 batch,2026-03-10",
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
  company: "company", "company name": "company", business: "company", "business name": "company",
  // Only used to add a client who isn't in the portal yet:
  contact_email: "contact_email", "contact email": "contact_email",
  phone: "phone", "phone number": "phone",
  package: "package", "plan package": "package", plan: "package",
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
  /** Empty for a client this import will add (see `create`). */
  clientId: string;
  /** A client who isn't in the portal yet, added on Apply. */
  create?: { name: string; email: string | null; phone: string | null; packageId: string | null; type: "DIRECT" | "ACE" };
  clientName: string;
  /** Sets the client's company name (empty: unchanged). */
  companyName?: string;
  type: "DIRECT" | "ACE" | null;
  shares: { executiveName: string; ratePercent: number }[];
  newExecutives: string[];
  monthsBeforePortal: number | undefined;
  effectiveFrom: Date;
  ace: { batchId: string; packageId: string; startOn: string; historical: boolean } | null;
  /** Months whose commission Apply will post now (payments already in the portal that would earn). */
  willPost: string[];
  /** True when this row puts the client in a non-historical ACE batch, which posts the months 1–6 lump sum. */
  aceLumpSum: boolean;
  /** Payments before this moment count as settled outside the portal and never earn. */
  settledThrough: Date | null;
  /** An additional package (not the client's main one), by its Stripe subscription: only its months are set. */
  packageSubscriptionId?: string;
};
export type Problem = { line: number; client: string; error: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
/** A real calendar date written YYYY-MM-DD (rejects 2025-13-01 and 2025-02-30). */
const isRealDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Owners: checks every row and matches it to a client. Nothing is changed. */
export async function planImport(
  text: string,
  opts: { createMissingExecutives: boolean; settledThrough?: string; createMissingClients?: boolean },
): Promise<{ ready: ReadyRow[]; problems: Problem[]; error?: string }> {
  await requirePermission("ace.manage");
  if (opts.settledThrough && !isRealDate(opts.settledThrough)) return { ready: [], problems: [], error: "The 'settled through' date must be a real date (YYYY-MM-DD)." };
  const settledThrough = opts.settledThrough ? startOfDayIn(opts.settledThrough, TZ) : null;
  const rows = parseCsv(text);
  const packages = await db.package.findMany();
  const subRows = await db.clientSubscription.findMany({ select: { stripeSubscriptionId: true, clientId: true } });
  const [clients, execs, batches, freeSlots, paidInvoices, earnedInvoices] = await Promise.all([
    db.client.findMany({ include: { package: true } }),
    db.executive.findMany(),
    db.aceBatch.findMany(),
    db.aceSlot.findMany({ where: { clientId: null }, select: { batchId: true, packageId: true } }),
    // With a "settled through" date, it decides what is history (even for invoices copied by the history load);
    // without one, invoices copied by the history load are history.
    db.invoice.findMany({ where: { kind: "SUBSCRIPTION", status: "paid", paidAt: { not: null }, ...(settledThrough ? {} : { backfilled: false }) }, orderBy: { paidAt: "asc" } }),
    db.commissionEntry.findMany({ where: { kind: "EARNED" }, distinct: ["invoiceId"], select: { invoiceId: true, clientId: true } }),
  ]);
  const earned = new Set(earnedInvoices.map((e) => e.invoiceId));
  const seenClients = new Map<string, number>();
  const free = new Map<string, number>();
  for (const s of freeSlots) free.set(`${s.batchId}:${s.packageId}`, (free.get(`${s.batchId}:${s.packageId}`) ?? 0) + 1);

  const ready: ReadyRow[] = [];
  const problems: Problem[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const key = r.client ?? "";
    const fail = (error: string) => problems.push({ line, client: key, error });
    if (!key) return fail("The client column is empty.");

    // A Stripe subscription (sub_…): the client's main package, or one of their additional packages.
    if (key.startsWith("sub_")) {
      const sr = subRows.find((s) => s.stripeSubscriptionId === key);
      const owner = clients.find((c) => c.stripeSubscriptionId === key) ?? (sr ? clients.find((c) => c.id === sr.clientId) : undefined);
      if (!owner) return fail(`No client has the Stripe subscription "${key}".`);
      if (owner.stripeSubscriptionId !== key) {
        const others = (["type", "executive_1", "rate_1", "executive_2", "rate_2", "ace_batch", "ace_start_date", "effective_from"] as const).filter((k) => r[k]);
        if (others.length) return fail(`For an additional package (${key}) only months_already_earned can be set; remove: ${others.join(", ")}.`);
        const m = Number(r.months_already_earned);
        if (r.months_already_earned === undefined || !Number.isInteger(m) || m < 0 || m > 12) return fail("Give months_already_earned for this package: a whole number from 0 to 12.");
        if (seenClients.has(key)) return fail(`This package appears more than once in the file (also line ${seenClients.get(key)}).`);
        seenClients.set(key, line);
        ready.push({
          line, willPost: [], aceLumpSum: false, settledThrough, clientId: owner.id, clientName: `${owner.name} (additional package)`, type: null,
          shares: [], newExecutives: [], monthsBeforePortal: m, effectiveFrom: startOfDayIn("2000-01-01", TZ), ace: null, packageSubscriptionId: key,
        });
        return;
      }
    }
    const matches = key.startsWith("sub_")
      ? clients.filter((c) => c.stripeSubscriptionId === key)
      : key.startsWith("cus_")
      ? clients.filter((c) => c.stripeCustomerId === key)
      : key.includes("@")
        ? clients.filter((c) => c.email?.toLowerCase() === key.toLowerCase())
        : clients.filter((c) => norm(c.name) === norm(key) || (c.companyName != null && norm(c.companyName) === norm(key)));
    if (matches.length > 1) return fail(`More than one client matches "${key}". Use their email or Stripe customer ID (cus_…) instead.`);
    let create: ReadyRow["create"];
    if (matches.length === 0) {
      if (!opts.createMissingClients) return fail("No client matches this name, email or Stripe customer ID. Fix it on the client page or in the sheet.");
      // Add them: the client column is their name; type and package say what they're on.
      if (key.startsWith("cus_") || key.includes("@")) return fail("To add a new client, put their name in the client column (and the email in contact_email).");
      const t = (r.type ?? "").toLowerCase();
      if (t !== "direct" && t !== "ace") return fail("To add a new client, give their type (Direct or ACE).");
      const pkg = r.package ? packages.find((p) => norm(p.name) === norm(r.package!)) : null;
      if (r.package && !pkg) return fail(`No package is called "${r.package}". Use a name from the Packages page.`);
      if (t === "ace" && !pkg) return fail("An ACE client needs their package.");
      const email = r.contact_email?.trim().toLowerCase() || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(`"${r.contact_email}" isn't a valid email.`);
      create = { name: key.trim().replace(/\s+/g, " "), email, phone: r.phone?.trim() || null, packageId: pkg?.id ?? null, type: t === "ace" ? "ACE" : "DIRECT" };
    }
    const client = matches[0] ?? {
      id: `new:${line}`,
      name: create!.name,
      type: create!.type,
      packageId: create!.packageId,
      package: packages.find((p) => p.id === create!.packageId) ?? null,
      aceSlotId: null,
      stripeSubscriptionId: null,
      commissionMonthsBeforePortal: 0,
    };

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
      if (findExecutive(execs, name)?.active === false) return fail(`"${name}" is an inactive executive. Reactivate them on the Commissions page first.`);
      if (Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-9) return fail(`Use at most two decimal places for rates (got ${rate}%).`);
      if (!findExecutive(execs, name)) {
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
      const isAce = type === "ACE" || (type === null && client.type === "ACE");
      if (isAce && (!Number.isInteger(m) || m < 0 || m > 6)) return fail("For ACE clients, months already earned are the paid months after the six prepaid by ACE: a whole number from 0 to 6.");
      if (!Number.isInteger(m) || m < 0 || m > 12) return fail("Months already earned must be a whole number from 0 to 12.");
      monthsBeforePortal = m;
    }

    const effectiveOn = r.effective_from ?? "2000-01-01";
    if (!isRealDate(effectiveOn)) return fail("effective_from must be a real date like 2025-01-31.");

    let ace: ReadyRow["ace"] = null;
    if (r.ace_batch || r.ace_start_date) {
      if (type !== "ACE" && !(type === null && client.type === "ACE")) return fail("ACE batch and start date are only for ACE clients.");
      if (!r.ace_batch || !r.ace_start_date || !isRealDate(r.ace_start_date)) return fail("ACE clients need both ace_batch and a real ace_start_date (YYYY-MM-DD).");
      if (client.aceSlotId) {
        ace = null; // already in a slot: leave it (re-running the import changes nothing)
      } else {
        const batch = batches.find((b) => norm(b.note ?? "") === norm(r.ace_batch!)) ?? batches.find((b) => b.purchasedAt.toISOString().slice(0, 10) === r.ace_batch);
        if (!batch) return fail(`No ACE batch is named "${r.ace_batch}". Use the batch's note or its purchase date.`);
        if (!client.packageId) return fail("Link this client to a package first, so the right ACE slot can be used.");
        if (!batch.historical && client.stripeSubscriptionId) {
          return fail("This client is on Stripe autopay, so ACE's prepaid months would be charged twice. Put them in a batch marked Historical, or end their Stripe subscription first.");
        }
        const k = `${batch.id}:${client.packageId}`;
        if (!free.get(k)) return fail(`No free ${client.package?.name ?? "package"} slot left in batch "${r.ace_batch}".`);
        free.set(k, free.get(k)! - 1);
        ace = { batchId: batch.id, packageId: client.packageId, startOn: r.ace_start_date, historical: batch.historical };
      }
    }

    // What Apply will post now: payments already in the portal that fall inside the commission window.
    let willPost: string[] = [];
    if (shares.length) {
      const window = windowMonthsFor({ type: type ?? client.type });
      // The main package's window (the one "months already earned" refers to); other packages have their own.
      const mainSub = "stripeSubscriptionId" in client ? client.stripeSubscriptionId : null;
      const mine = paidInvoices.filter((p) => p.clientId === client.id && packagePaidCents(p) > 0 && (!p.stripeSubscriptionId || !mainSub || p.stripeSubscriptionId === mainSub));
      const counted = mine.filter((p) => !settledThrough || p.billedAt >= settledThrough);
      const already = counted.filter((p) => earned.has(p.id)).length;
      const room = Math.max(0, window - (monthsBeforePortal ?? client.commissionMonthsBeforePortal) - already);
      willPost = counted.filter((p) => !earned.has(p.id)).slice(0, room).map((p) => monthOf(p.paidAt!, TZ));
    }
    if (seenClients.has(client.id)) return fail(`This client appears more than once in the file (also line ${seenClients.get(client.id)}). Keep one row per client.`);
    seenClients.set(client.id, line);

    ready.push({
      line,
      ...(r.company?.trim() ? { companyName: r.company.trim().replace(/\s+/g, " ") } : {}),
      create,
      willPost,
      aceLumpSum: !!ace && !ace.historical,
      settledThrough,
      clientId: client.id,
      clientName: client.name,
      type,
      shares,
      newExecutives,
      monthsBeforePortal,
      effectiveFrom: startOfDayIn(effectiveOn, TZ),
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
  // Additional packages first: their months must be set before a client's split posts their payments.
  const ordered = [...rows.filter((r) => r.packageSubscriptionId), ...rows.filter((r) => !r.packageSubscriptionId)];
  for (let r of ordered) {
    const fail = (error: string) => failed.push({ line: r.line, client: r.clientName, error });
    if (r.packageSubscriptionId) {
      // An additional package: only its months already earned (each package has its own window).
      const row = await db.clientSubscription.findUnique({ where: { stripeSubscriptionId: r.packageSubscriptionId } });
      if (!row) { fail("That package is no longer in the portal."); continue; }
      if (row.commissionMonthsBeforePortal !== r.monthsBeforePortal) {
        await db.clientSubscription.update({ where: { id: row.id }, data: { commissionMonthsBeforePortal: r.monthsBeforePortal } });
        await writeAudit({ actorId: actor.id, action: "package_commission_months_set", entity: "Client", entityId: row.clientId, before: { subscriptionId: row.stripeSubscriptionId, months: row.commissionMonthsBeforePortal }, after: { subscriptionId: row.stripeSubscriptionId, months: r.monthsBeforePortal, via: "import" } });
      }
      if (r.settledThrough) await settleHistory(row.clientId, r.settledThrough);
      // Payments since the settled date earn now (at the client's split, if it has one yet); lines an earlier
      // import posted in unpaid months are redone with these months.
      await recalculateOpenCommission(row.clientId);
      applied++;
      continue;
    }
    for (const name of r.newExecutives) {
      if (!(await db.executive.findFirst({ where: { name: { equals: name, mode: "insensitive" } } }))) {
        const e = await db.executive.create({ data: { name } });
        await writeAudit({ actorId: actor.id, action: "executive_added", entity: "Executive", entityId: e.id, after: { name, via: "import" } });
      }
    }
    if (r.create) {
      // Added once: a later run matches them by name instead.
      const existing = await db.client.findFirst({ where: { name: { equals: r.create.name, mode: "insensitive" } } });
      const c = existing ?? (await db.client.create({ data: { name: r.create.name, email: r.create.email, phone: r.create.phone, packageId: r.create.packageId, type: r.create.type, status: r.create.type === "ACE" ? "PREPAID_ACE" : "ONBOARDING" } }));
      if (!existing) await writeAudit({ actorId: actor.id, action: "client_added_by_import", entity: "Client", entityId: c.id, after: r.create });
      r = { ...r, clientId: c.id };
    }
    if (r.companyName) await db.client.update({ where: { id: r.clientId }, data: { companyName: r.companyName } });
    const previousType = (await db.client.findUniqueOrThrow({ where: { id: r.clientId }, select: { type: true } })).type;
    // Type first: the commission window (12 Direct, 6 ACE) depends on it. Restored if the split is refused.
    if (r.type) await db.client.update({ where: { id: r.clientId }, data: { type: r.type } });
    if (r.settledThrough) await settleHistory(r.clientId, r.settledThrough);
    if (r.shares.length) {
      const execs = await db.executive.findMany({ where: { active: true } });
      const id = (n: string) => findExecutive(execs, n)?.id;
      const res = await setClientCommission(r.clientId, {
        shares: r.shares.map((s) => ({ executiveId: id(s.executiveName) ?? "", ratePercent: s.ratePercent })),
        effectiveFrom: r.effectiveFrom,
        monthsBeforePortal: r.monthsBeforePortal,
      });
      if (!res.ok) {
        if (r.type) await db.client.update({ where: { id: r.clientId }, data: { type: previousType } });
        fail(res.error);
        continue;
      }
    } else if (r.monthsBeforePortal !== undefined) {
      // Months only (e.g. clients who came from ACE): who earns is set later, by another import or on the client page.
      const before = await db.client.findUniqueOrThrow({ where: { id: r.clientId }, select: { commissionMonthsBeforePortal: true } });
      if (before.commissionMonthsBeforePortal !== r.monthsBeforePortal) {
        await db.client.update({ where: { id: r.clientId }, data: { commissionMonthsBeforePortal: r.monthsBeforePortal } });
        await writeAudit({ actorId: actor.id, action: "commission_months_set", entity: "Client", entityId: r.clientId, before, after: { commissionMonthsBeforePortal: r.monthsBeforePortal, via: "import" } });
      }
    }
    if (r.ace) {
      // Only a historical batch may hold a client who is on Stripe autopay (checked again by assignSlot).
      const res = await assignSlot({ batchId: r.ace.batchId, packageId: r.ace.packageId, clientId: r.clientId, startOn: r.ace.startOn, confirmSubscribed: r.ace.historical });
      if (!res.ok) { fail(`Commission saved, but the ACE slot wasn't assigned: ${res.error}`); continue; }
    }
    // Lines an earlier import posted in unpaid months are redone with this row's split and months.
    await recalculateOpenCommission(r.clientId);
    applied++;
  }
  await writeAudit({ actorId: actor.id, action: "commission_import_applied", entity: "Import", entityId: new Date().toISOString(), after: { applied, failed: failed.length } });
  return { applied, failed };
}

/**
 * Bills issued before the 'settled through' date were paid out by hand: history (never earn), even when the client
 * paid them late, after that date (commission was paid for the month the bill was for). Bills issued on or after it
 * earn in the portal once paid, even when the history load copied them (it marks everything it copies as history).
 */
async function settleHistory(clientId: string, settledThrough: Date) {
  await db.invoice.updateMany({ where: { clientId, kind: "SUBSCRIPTION", status: "paid", billedAt: { lt: settledThrough } }, data: { backfilled: true } });
  await db.invoice.updateMany({ where: { clientId, kind: "SUBSCRIPTION", status: "paid", billedAt: { gte: settledThrough }, backfilled: true }, data: { backfilled: false } });
}

/** An executive by name: an exact match, else the only one whose first name is that name ("Albert" → "Albert Assad"). */
export function findExecutive<E extends { name: string }>(execs: E[], name: string): E | undefined {
  const n = norm(name);
  const exact = execs.find((e) => norm(e.name) === n);
  if (exact) return exact;
  const byFirst = execs.filter((e) => norm(e.name).split(" ")[0] === n);
  return byFirst.length === 1 ? byFirst[0] : undefined;
}
