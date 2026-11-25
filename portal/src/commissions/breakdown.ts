import type { Client, Invoice } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { monthOf, packagePaidCents, splitAt } from "@/domain/commission";
import { percentOfCents } from "@/lib/money";
import { commissionGroup } from "@/commissions/engine";

const tz = () => process.env.BUSINESS_TZ ?? "America/New_York";

export type BreakdownRow = {
  clientName: string;
  href: string;
  /** "8 of 12", "ACE 1–6", or "—" for a refund. */
  payout: string;
  /** Month of this package's last commission payout ("2027-03"), when known. */
  finalMonth: string | null;
  /** What the client paid on the invoice (incl. card fee), and how. */
  paidCents: number | null;
  paidAt: Date | null;
  method: string | null;
  rateBp: number;
  commissionCents: number;
  notes: string[];
  /** Not paid yet this month: the commission it should earn once paid. */
  expected: boolean;
};
export type BreakdownGroup = { packageName: string; rows: BreakdownRow[]; totalCents: number; expectedCents: number };
export type ExecutiveBreakdown = {
  executiveId: string;
  executiveName: string;
  groups: BreakdownGroup[];
  totalCents: number;
  expectedCents: number;
  status: "PAID" | "OPEN";
  paidAt: Date | null;
};

/** "2026-11" plus n months → "2027-03". */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function methodLabel(i: Pick<Invoice, "paymentMethodType" | "cardFunding" | "outsideMethod" | "paidOutsideAt">): string | null {
  if (i.paidOutsideAt) return i.outsideMethod ? `Outside Stripe (${i.outsideMethod})` : "Outside Stripe";
  if (i.paymentMethodType === "card") return i.cardFunding === "credit" ? "CC" : i.cardFunding === "debit" ? "Debit" : "Card";
  if (i.paymentMethodType === "us_bank_account") return "ACH";
  if (i.paymentMethodType === "link") return "Link";
  return i.paymentMethodType;
}

const PACKAGE_ORDER = ["Essentials", "Growth", "Enterprise", "Enterprise Custom"];

/**
 * Owners / Super Admin: each executive's commission for one month, client by client and grouped by package, like
 * the commission tracker. For the current or a future month it also lists the clients still expected to pay.
 */
export async function monthlyBreakdown(month: string, now: Date = new Date()): Promise<ExecutiveBreakdown[]> {
  await requirePermission("commissions.view");
  const [executives, entries, statements] = await Promise.all([
    db.executive.findMany({ orderBy: { name: "asc" } }),
    db.commissionEntry.findMany({ where: { month }, orderBy: [{ occurredAt: "asc" }] }),
    db.commissionStatement.findMany({ where: { month } }),
  ]);
  const showExpected = month >= monthOf(now, tz());
  const shares = await db.commissionShare.findMany();
  const sharedClientIds = showExpected ? [...new Set(shares.map((s) => s.clientId))] : [];
  const clientIds = [...new Set([...entries.map((e) => e.clientId), ...sharedClientIds])];
  const [clients, subs, packages, invoices] = await Promise.all([
    db.client.findMany({ where: { id: { in: clientIds } } }),
    db.clientSubscription.findMany({ where: { clientId: { in: clientIds } } }),
    db.package.findMany(),
    db.invoice.findMany({
      where: { OR: [{ id: { in: entries.map((e) => e.invoiceId) } }, ...(showExpected ? [{ clientId: { in: sharedClientIds }, kind: "SUBSCRIPTION" as const, status: "paid" }] : [])] },
    }),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const subById = new Map(subs.map((s) => [s.stripeSubscriptionId, s]));
  const pkgName = new Map(packages.map((p) => [p.id, p.name]));
  const execName = new Map(executives.map((e) => [e.id, e.name]));
  const sharesOf = (clientId: string) => shares.filter((s) => s.clientId === clientId);

  /** The package group (main or another subscription) an invoice belongs to, with its window. */
  const groupOf = (c: Client, subscriptionId: string | null) => {
    const isMain = !subscriptionId || !c.stripeSubscriptionId || subscriptionId === c.stripeSubscriptionId;
    const sub = isMain ? (c.stripeSubscriptionId ? subById.get(c.stripeSubscriptionId) : undefined) : subById.get(subscriptionId!);
    const g = commissionGroup(c, isMain ? c.stripeSubscriptionId : subscriptionId, isMain ? 0 : sub?.commissionMonthsBeforePortal ?? 0);
    const pkgId = (isMain ? c.packageId : null) ?? sub?.packageId ?? null;
    const packageName = (pkgId && pkgName.get(pkgId)) || sub?.productName || "Other";
    return { key: isMain ? "main" : subscriptionId!, packageName, windowMonths: g.windowMonths, monthsBefore: g.monthsBefore };
  };
  const hrefOf = (c: Client) => `/clients/${c.stripeSubscriptionId ?? c.id}`;
  const otherOwners = (c: Client, execId: string, at: Date) =>
    splitAt(sharesOf(c.id), at)
      .filter((s) => s.executiveId !== execId)
      .map((s) => `Split with ${execName.get(s.executiveId) ?? "another executive"} (${s.rateBp / 100}%)`);

  const result: ExecutiveBreakdown[] = [];
  for (const ex of executives) {
    const rows: (BreakdownRow & { packageName: string })[] = [];
    const earnedKeys = new Set<string>();
    for (const e of entries.filter((x) => x.executiveId === ex.id)) {
      const c = clientById.get(e.clientId);
      if (!c) continue;
      const inv = invoiceById.get(e.invoiceId);
      const g = groupOf(c, inv?.stripeSubscriptionId ?? null);
      if (e.kind === "EARNED") earnedKeys.add(`${c.id}|${g.key}`);
      const notes: string[] = [];
      if (e.kind === "ACE_PREPAID") notes.push("ACE prepaid months 1–6");
      if (e.kind === "CLAWBACK") notes.push("Refund (commission taken back)");
      if (e.kind === "EARNED" && e.windowIndex === g.windowMonths) notes.push("Final payout");
      if (inv && inv.discountCents > 0) notes.push("Discounted");
      notes.push(...otherOwners(c, ex.id, e.occurredAt));
      rows.push({
        packageName: e.kind === "ACE_PREPAID" ? `ACE: ${g.packageName}` : g.packageName,
        clientName: c.name,
        href: hrefOf(c),
        payout: e.kind === "ACE_PREPAID" ? "ACE 1–6" : e.windowIndex ? `${e.windowIndex} of ${g.windowMonths}` : "—",
        finalMonth: e.kind === "EARNED" && e.windowIndex ? addMonths(month, g.windowMonths - e.windowIndex) : null,
        paidCents: inv ? inv.amountPaidCents : null,
        paidAt: inv?.paidAt ?? e.occurredAt,
        method: inv ? methodLabel(inv) : null,
        rateBp: e.rateBp,
        commissionCents: e.amountCents,
        notes,
        expected: false,
      });
    }

    if (showExpected) {
      // Clients this executive currently earns on, whose package still has paid months left and hasn't paid this month.
      for (const c of clients) {
        if (c.endedAt) continue;
        const mine = splitAt(sharesOf(c.id), now).find((s) => s.executiveId === ex.id);
        if (!mine) continue;
        const keys = new Set<string | null>([c.stripeSubscriptionId, ...subs.filter((s) => s.clientId === c.id && !s.endedAt).map((s) => s.stripeSubscriptionId)]);
        for (const subId of keys) {
          const g = groupOf(c, subId);
          if (earnedKeys.has(`${c.id}|${g.key}`)) continue;
          const payments = invoices
            .filter((i) => i.clientId === c.id && i.status === "paid" && i.kind === "SUBSCRIPTION" && packagePaidCents(i) > 0)
            .filter((i) => groupOf(c, i.stripeSubscriptionId).key === g.key)
            .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));
          const earned = g.monthsBefore + payments.filter((i) => !i.backfilled).length;
          if (earned >= g.windowMonths) continue;
          // The last payment (even one from before the portal) shows what this month's bill will likely be;
          // without one, the package's list price.
          const last = payments[0];
          const pkg = packages.find((p) => p.name === g.packageName);
          const base = last ? packagePaidCents(last) : pkg && !pkg.isCustom ? pkg.monthlyPriceCents : 0;
          rows.push({
            packageName: g.packageName,
            clientName: c.name,
            href: hrefOf(c),
            payout: `${earned + 1} of ${g.windowMonths}`,
            finalMonth: addMonths(month, g.windowMonths - (earned + 1)),
            paidCents: null,
            paidAt: null,
            method: null,
            rateBp: mine.rateBp,
            commissionCents: percentOfCents(base, mine.rateBp),
            notes: ["Awaiting payment", ...(earned + 1 === g.windowMonths ? ["Final payout"] : []), ...otherOwners(c, ex.id, now)],
            expected: true,
          });
        }
      }
    }

    if (!rows.length) continue;
    const names = [...new Set(rows.map((r) => r.packageName))].sort((a, b) => {
      const ia = PACKAGE_ORDER.indexOf(a.replace(/^ACE: /, "")) + (a.startsWith("ACE: ") ? 10 : 0);
      const ib = PACKAGE_ORDER.indexOf(b.replace(/^ACE: /, "")) + (b.startsWith("ACE: ") ? 10 : 0);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const groups = names.map((packageName) => {
      const rs = rows.filter((r) => r.packageName === packageName).sort((a, b) => Number(a.expected) - Number(b.expected) || a.clientName.localeCompare(b.clientName));
      return {
        packageName,
        rows: rs.map(({ packageName: _p, ...r }) => r),
        totalCents: rs.filter((r) => !r.expected).reduce((n, r) => n + r.commissionCents, 0),
        expectedCents: rs.filter((r) => r.expected).reduce((n, r) => n + r.commissionCents, 0),
      };
    });
    const st = statements.find((s) => s.executiveId === ex.id);
    const paid = st?.status === "PAID";
    result.push({
      executiveId: ex.id,
      executiveName: ex.name,
      groups,
      totalCents: paid ? st!.totalCents ?? 0 : groups.reduce((n, g) => n + g.totalCents, 0),
      expectedCents: groups.reduce((n, g) => n + g.expectedCents, 0),
      status: paid ? "PAID" : "OPEN",
      paidAt: st?.paidAt ?? null,
    });
  }
  return result;
}
