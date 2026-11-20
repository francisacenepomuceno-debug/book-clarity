import { db } from "@/lib/db";
import { bucketsBetween, previous, type Period } from "@/domain/periods";

/**
 * Report figures, computed on request from the portal's own tables (spec §13).
 * Revenue is cash collected by payment date; an ACE batch counts once, on the day it was paid.
 * Refunds reduce the period of the original payment (refund dates aren't stored).
 */

const inPeriod = (p: Period) => ({ gte: p.start, lt: p.end });
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

export async function withPrevious<T>(fn: (p: Period) => Promise<T>, p: Period) {
  const prev = previous(p);
  const [current, previousValue] = await Promise.all([fn(p), fn(prev)]);
  return { period: p, previousPeriod: prev, current, previous: previousValue };
}

export type Revenue = {
  types: { packagesCents: number; onboardingCents: number; cardFeesCents: number; aceCents: number; otherCents: number; taxCents: number; refundsCents: number; totalCents: number };
  byPackage: { name: string; cents: number }[];
};

export async function revenue(p: Period): Promise<Revenue> {
  const [invoices, batches] = await Promise.all([
    db.invoice.findMany({ where: { status: "paid", paidAt: inPeriod(p), kind: { not: "ACE_BATCH" } }, include: { client: { include: { package: true } } } }),
    db.aceBatch.findMany({ where: { paidAt: inPeriod(p) } }),
  ]);
  const t = { packagesCents: 0, onboardingCents: 0, cardFeesCents: 0, aceCents: 0, otherCents: 0, taxCents: 0, refundsCents: 0, totalCents: 0 };
  const pkgs = new Map<string, number>();
  for (const i of invoices) {
    const rest = i.amountPaidCents - i.cardFeeCents - i.onboardingCents - i.taxCents;
    t.cardFeesCents += i.cardFeeCents;
    t.onboardingCents += i.onboardingCents;
    t.taxCents += i.taxCents;
    t.refundsCents -= i.refundedCents;
    if (i.kind === "SUBSCRIPTION") {
      t.packagesCents += rest;
      add(pkgs, i.client?.package?.name ?? "Package not set", rest - i.refundedPackageCents);
    } else {
      t.otherCents += rest;
    }
  }
  t.aceCents = batches.reduce((n, b) => n + b.totalCents, 0);
  t.cardFeesCents += batches.reduce((n, b) => n + b.cardFeeCents, 0);
  t.totalCents = t.packagesCents + t.onboardingCents + t.cardFeesCents + t.aceCents + t.otherCents + t.taxCents + t.refundsCents;
  return { types: t, byPackage: [...pkgs].map(([name, cents]) => ({ name, cents })).sort(byName) };
}

/** An autopay bill still unpaid this many days after its bill date is past due, even with no recorded failure (e.g. history). */
export const PAST_DUE_AFTER_DAYS = 3;

/**
 * Bills issued in the period (by bill date) and what was paid on them; plus what's past due now.
 * Past due uses today's invoice statuses (it isn't reconstructed for past periods) and leaves out clients who have left.
 */
export async function expectedVsCollected(p: Period, now: Date = new Date()) {
  const asOf = new Date(Math.min(p.end.getTime(), now.getTime()));
  const graceStart = new Date(asOf.getTime() - PAST_DUE_AFTER_DAYS * 86400_000);
  const billed = await db.invoice.findMany({ where: { kind: "SUBSCRIPTION", billedAt: inPeriod(p), status: { notIn: ["void", "draft"] } } });
  const owed = await db.invoice.findMany({
    where: {
      kind: "SUBSCRIPTION",
      status: { in: ["open", "uncollectible"] },
      processingSince: null,
      client: { endedAt: null },
      OR: [
        { firstFailedAt: { lt: asOf } },
        { dueAt: { lt: asOf } },
        { dueAt: null, billedAt: { lt: graceStart } },
      ],
    },
  });
  return {
    expectedCents: billed.reduce((n, i) => n + i.totalCents, 0),
    collectedCents: billed.reduce((n, i) => n + i.amountPaidCents, 0),
    outstandingPastDueCents: owed.reduce((n, i) => n + i.totalCents - i.amountPaidCents, 0),
  };
}

type ClientLine = { id: string; name: string; type: "DIRECT" | "ACE"; packageName: string; date: Date };

/** When each client started: onboarding fee paid, else ACE slot start, else their Stripe subscription start, else first paid monthly invoice. */
async function clientStarts(): Promise<ClientLine[]> {
  const [clients, slots, firsts] = await Promise.all([
    db.client.findMany({ include: { package: true, onboarding: true } }),
    db.aceSlot.findMany({ where: { clientId: { not: null } } }),
    db.invoice.groupBy({ by: ["clientId"], where: { kind: "SUBSCRIPTION", status: "paid", amountPaidCents: { gt: 0 }, clientId: { not: null } }, _min: { paidAt: true } }),
  ]);
  const slotStart = new Map(slots.map((s) => [s.clientId!, s.startDate]));
  const firstPaid = new Map(firsts.map((f) => [f.clientId!, f._min.paidAt]));
  const out: ClientLine[] = [];
  for (const c of clients) {
    const date = c.onboarding?.feePaidAt ?? slotStart.get(c.id) ?? c.startedAt ?? firstPaid.get(c.id) ?? null;
    if (date) out.push({ id: c.id, name: c.name, type: c.type, packageName: c.package?.name ?? "Package not set", date });
  }
  return out;
}

const within = (d: Date, p: Period) => d >= p.start && d < p.end;

export async function newClients(p: Period) {
  const list = (await clientStarts()).filter((c) => within(c.date, p)).sort(byName);
  const pk = new Map<string, number>();
  for (const c of list) add(pk, c.packageName, 1);
  return {
    total: list.length,
    direct: list.filter((c) => c.type === "DIRECT").length,
    ace: list.filter((c) => c.type === "ACE").length,
    byPackage: [...pk].map(([name, count]) => ({ name, count })).sort(byName),
    clients: list,
  };
}

export async function endedClients(p: Period) {
  const rows = await db.client.findMany({ where: { endedAt: inPeriod(p) }, include: { package: true }, orderBy: { name: "asc" } });
  const clients: ClientLine[] = rows.map((c) => ({ id: c.id, name: c.name, type: c.type, packageName: c.package?.name ?? "Package not set", date: c.endedAt! }));
  return { total: clients.length, direct: clients.filter((c) => c.type === "DIRECT").length, ace: clients.filter((c) => c.type === "ACE").length, clients };
}

/** ACE clients whose prepaid six months ended in the period: how many went on to pay directly. */
export async function aceContinuation(p: Period) {
  const rows = await db.client.findMany({ where: { type: "ACE", acePrepaidUntil: inPeriod(p) }, orderBy: { name: "asc" } });
  const outcome = (c: (typeof rows)[number]) =>
    c.stripeSubscriptionId || c.continuationDecision === "CONTINUING" ? "continued" : c.endedAt ? "ended" : "undecided";
  const clients = rows.map((c) => ({ id: c.id, name: c.name, prepaidUntil: c.acePrepaidUntil!, outcome: outcome(c) }));
  const continued = clients.filter((c) => c.outcome === "continued").length;
  const ended = clients.filter((c) => c.outcome === "ended").length;
  return {
    continued,
    ended,
    undecided: clients.length - continued - ended,
    ratePct: continued + ended === 0 ? null : Math.round((continued / (continued + ended)) * 1000) / 10,
    clients,
  };
}

/** Active clients and monthly recurring revenue for the `n` periods ending with `last`. */
export async function activeAndMrr(last: Period, n: number) {
  const buckets = bucketsBetween(last, n);
  const from = buckets[0].start;
  const [invoices, slots, aceClients] = await Promise.all([
    db.invoice.findMany({ where: { kind: "SUBSCRIPTION", status: { notIn: ["void", "draft"] }, billedAt: { gte: from, lt: last.end }, clientId: { not: null } } }),
    db.aceSlot.findMany({ where: { clientId: { not: null }, startDate: { not: null } } }),
    db.client.findMany({ where: { type: "ACE", acePrepaidUntil: { not: null } }, select: { id: true, acePrepaidUntil: true } }),
  ]);
  const prepaidUntil = new Map(aceClients.map((c) => [c.id, c.acePrepaidUntil]));
  return buckets.map((b) => {
    const active = new Set<string>();
    let mrrCents = 0;
    for (const i of invoices) {
      if (!within(i.billedAt, b)) continue;
      active.add(i.clientId!);
      mrrCents += i.subtotalCents - i.discountCents - i.cardFeeCents - i.onboardingCents;
    }
    for (const s of slots) {
      const until = s.prepaidUntil ?? prepaidUntil.get(s.clientId!) ?? null;
      if (s.startDate! < b.end && until && until >= b.start) active.add(s.clientId!);
    }
    return { key: b.key, label: b.label, active: active.size, mrrCents };
  });
}

/** Discounts on paid bills, plus retroactive discounts (partial refunds) by the date they were given. */
export async function discountsGiven(p: Period) {
  const [rows, retro] = await Promise.all([
    db.invoice.findMany({ where: { status: "paid", paidAt: inPeriod(p), discountCents: { gt: 0 } }, include: { client: true } }),
    db.auditLog.findMany({ where: { action: "discount_retroactive", at: inPeriod(p) } }),
  ]);
  const retroInvoices = retro.length ? await db.invoice.findMany({ where: { id: { in: retro.map((r) => r.entityId) } }, include: { client: true } }) : [];
  const clientOf = new Map(retroInvoices.map((i) => [i.id, i.client?.name ?? "Unknown client"]));
  const m = new Map<string, number>();
  let total = 0;
  for (const r of rows) { add(m, r.client?.name ?? "Unknown client", r.discountCents); total += r.discountCents; }
  for (const a of retro) {
    const cents = Number((a.after as { amountCents?: number } | null)?.amountCents ?? 0);
    add(m, clientOf.get(a.entityId) ?? "Unknown client", cents);
    total += cents;
  }
  return { totalCents: total, byClient: [...m].map(([name, cents]) => ({ name, cents })).sort(byName) };
}

export async function commissionsReport(p: Period) {
  const [entries, execs, paid] = await Promise.all([
    db.commissionEntry.findMany({ where: { occurredAt: inPeriod(p) } }),
    db.executive.findMany(),
    db.commissionStatement.findMany({ where: { status: "PAID" } }),
  ]);
  const paidMonths = new Set(paid.map((s) => `${s.executiveId}:${s.month}`));
  const names = new Map(execs.map((e) => [e.id, e.name]));
  const by = new Map<string, { name: string; earnedCents: number; clawbackCents: number; netCents: number; paidCents: number; unpaidCents: number }>();
  for (const e of entries) {
    const r = by.get(e.executiveId) ?? { name: names.get(e.executiveId) ?? "Unknown", earnedCents: 0, clawbackCents: 0, netCents: 0, paidCents: 0, unpaidCents: 0 };
    if (e.kind === "CLAWBACK") r.clawbackCents += e.amountCents;
    else r.earnedCents += e.amountCents;
    r.netCents += e.amountCents;
    if (paidMonths.has(`${e.executiveId}:${e.month}`)) r.paidCents += e.amountCents;
    else r.unpaidCents += e.amountCents;
    by.set(e.executiveId, r);
  }
  const byExecutive = [...by.values()].sort(byName);
  const sum = (k: "earnedCents" | "clawbackCents" | "netCents" | "paidCents" | "unpaidCents") => byExecutive.reduce((n, r) => n + r[k], 0);
  return { byExecutive, totals: { earnedCents: sum("earnedCents"), clawbackCents: sum("clawbackCents"), netCents: sum("netCents"), paidCents: sum("paidCents"), unpaidCents: sum("unpaidCents") } };
}
