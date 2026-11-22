import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { CONTINUATION_NOTICE_DAYS } from "@/domain/ace";

const DAY = 86400_000;
export const DECLINE_LOOKBACK_DAYS = 7;
export const DISCOUNT_ENDING_DAYS = 30;
export const STUCK_ONBOARDING_DAYS = 3;

export type AlertGroup = {
  kind: "declines" | "atRisk" | "aceMonth6" | "aceEnded" | "openSlots" | "discountsEnding" | "stuckOnboarding" | "countersign";
  title: string;
  items: { name: string; detail: string; href: string }[];
};

const clientHref = (c: { id: string; stripeSubscriptionId: string | null }) => `/clients/${c.stripeSubscriptionId ?? c.id}`;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
function addMonths(d: Date, months: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + months);
  return x;
}

/** What needs an Owner's attention today (spec §12). Empty groups are left out. */
export async function dashboardAlerts(now: Date = new Date()): Promise<AlertGroup[]> {
  const [declined, risky, aceSoon, aceEnded, openSlots, discounts, stuck, unsigned] = await Promise.all([
    db.invoice.findMany({
      where: { kind: "SUBSCRIPTION", status: "open", firstFailedAt: { gte: new Date(now.getTime() - DECLINE_LOOKBACK_DAYS * DAY) }, client: { endedAt: null } },
      include: { client: true },
    }),
    db.client.findMany({ where: { status: { in: ["AT_RISK", "SUSPENDED"] }, endedAt: null } }),
    db.client.findMany({
      where: { type: "ACE", endedAt: null, continuationDecision: null, stripeSubscriptionId: null, acePrepaidUntil: { gte: now, lte: new Date(now.getTime() + CONTINUATION_NOTICE_DAYS * DAY) } },
    }),
    // Stays until an Owner or the Super Admin records Continuing or Ending on the client's page.
    db.client.findMany({
      where: { type: "ACE", endedAt: null, continuationDecision: null, stripeSubscriptionId: null, acePrepaidUntil: { lt: now } },
      orderBy: { acePrepaidUntil: "asc" },
    }),
    db.aceSlot.groupBy({ by: ["batchId"], where: { clientId: null }, _count: { _all: true } }),
    db.discount.findMany({ where: { replacedAt: null, client: { endedAt: null } }, include: { client: true } }),
    db.onboarding.findMany({ where: { completedAt: null, lastProgressAt: { lte: new Date(now.getTime() - STUCK_ONBOARDING_DAYS * DAY) }, client: { endedAt: null } }, include: { client: true } }),
    db.onboarding.findMany({ where: { signedAt: { not: null }, countersignedAt: null, client: { endedAt: null } }, include: { client: true } }),
  ]);
  const batches = openSlots.length ? await db.aceBatch.findMany({ where: { id: { in: openSlots.map((s) => s.batchId) } } }) : [];
  const batchName = new Map(batches.map((b) => [b.id, b.note?.trim() || `Batch of ${fmtDate(b.purchasedAt)}`]));

  const groups: AlertGroup[] = [
    {
      kind: "declines",
      title: `Payments declined in the last ${DECLINE_LOOKBACK_DAYS} days`,
      items: [...new Map(declined.map((i) => [i.clientId, i])).values()].map((i) => ({ name: i.client!.name, detail: `declined ${fmtDate(i.firstFailedAt)}`, href: clientHref(i.client!) })),
    },
    {
      kind: "atRisk",
      title: "At risk or suspended",
      items: risky.map((c) => ({ name: c.name, detail: c.status === "SUSPENDED" ? "suspended" : "at risk", href: clientHref(c) })),
    },
    {
      kind: "aceMonth6",
      title: `ACE clients reaching month 6 within ${CONTINUATION_NOTICE_DAYS} days, no decision yet`,
      items: aceSoon.map((c) => ({ name: c.name, detail: `prepaid until ${fmtDate(c.acePrepaidUntil)}`, href: clientHref(c) })),
    },
    {
      kind: "aceEnded",
      title: "ACE prepaid time ended, no decision yet (not being billed)",
      items: aceEnded.map((c) => ({ name: c.name, detail: `prepaid ended ${fmtDate(c.acePrepaidUntil)}${c.clientAnswer === "YES" ? " · client said yes" : ""}`, href: clientHref(c) })),
    },
    {
      kind: "openSlots",
      title: "ACE batches with open slots",
      items: openSlots.map((s) => ({ name: batchName.get(s.batchId) ?? "Batch", detail: `${s._count._all} open`, href: `/ace/${s.batchId}` })),
    },
    {
      kind: "discountsEnding",
      title: `Discounts ending in the next ${DISCOUNT_ENDING_DAYS} days`,
      items: discounts
        .map((d) => ({ d, end: addMonths(d.createdAt, d.months) }))
        .filter(({ end }) => end >= now && end <= new Date(now.getTime() + DISCOUNT_ENDING_DAYS * DAY))
        .map(({ d, end }) => ({ name: d.client.name, detail: `ends about ${fmtDate(end)}`, href: clientHref(d.client) })),
    },
    {
      kind: "stuckOnboarding",
      title: `Onboarding with no progress for ${STUCK_ONBOARDING_DAYS}+ days`,
      items: stuck.map((o) => ({ name: o.client.name, detail: `last progress ${fmtDate(o.lastProgressAt)}`, href: clientHref(o.client) })),
    },
    {
      kind: "countersign",
      title: "Agreements waiting for countersignature",
      items: unsigned.map((o) => ({ name: o.client.name, detail: `signed ${fmtDate(o.signedAt)}`, href: `/contracts/${o.id}` })),
    },
  ];
  return groups.map((g) => ({ ...g, items: g.items.sort(byName) })).filter((g) => g.items.length > 0);
}
