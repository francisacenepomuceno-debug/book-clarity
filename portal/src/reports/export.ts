import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { bucketsBetween, change, periodOf, type Period } from "@/domain/periods";
import { formatUsd } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { activeAndMrr, aceContinuation, commissionsReport, discountsGiven, endedClients, expectedVsCollected, newClients, revenue, withPrevious } from "@/reports/queries";

export type Table = { title: string; columns: string[]; rows: string[][] };

export const REPORTS = [
  { key: "revenue", title: "Revenue collected" },
  { key: "expected", title: "Expected vs collected" },
  { key: "new-clients", title: "New clients" },
  { key: "ended-clients", title: "Cancellations and ended clients" },
  { key: "ace-continuation", title: "ACE continuation" },
  { key: "active-mrr", title: "Active clients and MRR" },
  { key: "discounts", title: "Discounts given" },
  { key: "commissions", title: "Commissions" },
] as const;
export type ReportKey = (typeof REPORTS)[number]["key"] | "all";
export const isReportKey = (k: string): k is ReportKey => k === "all" || REPORTS.some((r) => r.key === k);

/** "+$50.00 (+12.5%)", "new" when there was nothing before, "—" when both are zero. */
export function fmtChange(cur: number, prev: number, money: boolean): string {
  const c = change(cur, prev);
  if (cur === 0 && prev === 0) return "—";
  if (c.pct === null) return "new";
  const sign = c.delta > 0 ? "+" : c.delta < 0 ? "−" : "";
  const abs = money ? formatUsd(Math.abs(c.delta)) : String(Math.abs(c.delta));
  return `${sign}${abs} (${c.pct > 0 ? "+" : ""}${c.pct}%)`;
}

type Line = [label: string, cur: number, prev: number, money: boolean];
/** A period that hasn't finished yet is labelled "(so far)" so a part-month never reads as a drop. */
export const periodLabel = (p: Period, now: Date) => (p.end > now ? `${p.label} (so far)` : p.label);
const compare = (title: string, cur: Period, prev: Period, lines: Line[], now: Date): Table => ({
  title,
  columns: [title.split(" (")[0], periodLabel(cur, now), periodLabel(prev, now), "Change"],
  rows: lines.map(([l, c, p, m]) => [l, m ? formatUsd(c) : String(c), m ? formatUsd(p) : String(p), fmtChange(c, p, m)]),
});

async function tablesFor(key: Exclude<ReportKey, "all">, p: Period, now: Date): Promise<Table[]> {
  switch (key) {
    case "revenue": {
      const r = await withPrevious(revenue, p);
      const [a, b] = [r.current.types, r.previous.types];
      const lines: Line[] = [
        ["Monthly packages", a.packagesCents, b.packagesCents, true],
        ["Onboarding fees", a.onboardingCents, b.onboardingCents, true],
        ["ACE payments", a.aceCents, b.aceCents, true],
        ["Card fees (3%)", a.cardFeesCents, b.cardFeesCents, true],
        ["Other invoices", a.otherCents, b.otherCents, true],
        ["Sales tax", a.taxCents, b.taxCents, true],
        ["Refunds", a.refundsCents, b.refundsCents, true],
        ["Total collected", a.totalCents, b.totalCents, true],
      ];
      const names = [...new Set([...r.current.byPackage, ...r.previous.byPackage].map((x) => x.name))].sort();
      const of = (list: { name: string; cents: number }[], n: string) => list.find((x) => x.name === n)?.cents ?? 0;
      return [
        compare("Revenue", r.period, r.previousPeriod, lines, now),
        compare("Monthly package revenue (by package)", r.period, r.previousPeriod, names.map((n) => [n, of(r.current.byPackage, n), of(r.previous.byPackage, n), true]), now),
      ];
    }
    case "expected": {
      const r = await withPrevious((x) => expectedVsCollected(x), p);
      const pct = (x: { expectedCents: number; collectedCents: number }) => (x.expectedCents ? Math.round((x.collectedCents / x.expectedCents) * 1000) / 10 : 0);
      const t = compare("Expected vs collected", r.period, r.previousPeriod, [
        ["Expected (monthly bills)", r.current.expectedCents, r.previous.expectedCents, true],
        ["Collected", r.current.collectedCents, r.previous.collectedCents, true],
        ["Outstanding past due (today's statuses)", r.current.outstandingPastDueCents, r.previous.outstandingPastDueCents, true],
      ], now);
      t.rows.push(["Collected %", `${pct(r.current)}%`, `${pct(r.previous)}%`, ""]);
      return [t];
    }
    case "new-clients": {
      const r = await withPrevious(newClients, p);
      const names = [...new Set([...r.current.byPackage, ...r.previous.byPackage].map((x) => x.name))].sort();
      const of = (list: { name: string; count: number }[], n: string) => list.find((x) => x.name === n)?.count ?? 0;
      return [
        compare("New clients", r.period, r.previousPeriod, [
          ["Total", r.current.total, r.previous.total, false],
          ["Direct", r.current.direct, r.previous.direct, false],
          ["ACE", r.current.ace, r.previous.ace, false],
          ...names.map((n): Line => [`Package: ${n}`, of(r.current.byPackage, n), of(r.previous.byPackage, n), false]),
        ], now),
        { title: `New clients in ${r.period.label}`, columns: ["Client", "Type", "Package", "Started"], rows: r.current.clients.map((c) => [c.name, c.type === "ACE" ? "ACE" : "Direct", c.packageName, fmtDate(c.date)]) },
      ];
    }
    case "ended-clients": {
      const r = await withPrevious(endedClients, p);
      return [
        compare("Ended clients", r.period, r.previousPeriod, [
          ["Total", r.current.total, r.previous.total, false],
          ["Direct", r.current.direct, r.previous.direct, false],
          ["ACE", r.current.ace, r.previous.ace, false],
        ], now),
        { title: `Ended in ${r.period.label}`, columns: ["Client", "Type", "Package", "Ended"], rows: r.current.clients.map((c) => [c.name, c.type === "ACE" ? "ACE" : "Direct", c.packageName, fmtDate(c.date)]) },
      ];
    }
    case "ace-continuation": {
      const r = await withPrevious(aceContinuation, p);
      const rate = (x: { ratePct: number | null }) => (x.ratePct === null ? "—" : `${x.ratePct}%`);
      const t = compare("ACE clients reaching month 6", r.period, r.previousPeriod, [
        ["Continued (pay directly)", r.current.continued, r.previous.continued, false],
        ["Ended", r.current.ended, r.previous.ended, false],
        ["Undecided", r.current.undecided, r.previous.undecided, false],
      ], now);
      t.rows.push(["Continuation rate", rate(r.current), rate(r.previous), ""]);
      return [t, { title: `ACE clients whose prepaid months ended in ${r.period.label}`, columns: ["Client", "Prepaid until", "Outcome"], rows: r.current.clients.map((c) => [c.name, fmtDate(c.prepaidUntil), c.outcome]) }];
    }
    case "active-mrr": {
      const rows = await mrrTrend(p, now);
      return [{ title: "Active clients and MRR (by month)", columns: ["Month", "Active clients", "MRR"], rows: rows.map((r) => [r.label, String(r.active), formatUsd(r.mrrCents)]) }];
    }
    case "discounts": {
      const r = await withPrevious(discountsGiven, p);
      return [
        compare("Discounts given", r.period, r.previousPeriod, [["Total discounts", r.current.totalCents, r.previous.totalCents, true]], now),
        { title: `Discounts by client, ${r.period.label}`, columns: ["Client", "Discount"], rows: r.current.byClient.map((c) => [c.name, formatUsd(c.cents)]) },
      ];
    }
    case "commissions": {
      const r = await withPrevious(commissionsReport, p);
      const money = (n: number) => formatUsd(n);
      return [
        compare("Commissions", r.period, r.previousPeriod, [
          ["Earned", r.current.totals.earnedCents, r.previous.totals.earnedCents, true],
          ["Clawbacks", r.current.totals.clawbackCents, r.previous.totals.clawbackCents, true],
          ["Net", r.current.totals.netCents, r.previous.totals.netCents, true],
        ], now),
        {
          title: `Commissions by executive, ${r.period.label}`,
          columns: ["Executive", "Earned", "Clawbacks", "Net", "Paid", "Unpaid"],
          rows: [
            ...r.current.byExecutive.map((e) => [e.name, money(e.earnedCents), money(e.clawbackCents), money(e.netCents), money(e.paidCents), money(e.unpaidCents)]),
            ...(r.current.byExecutive.length ? [["Total", ...[r.current.totals.earnedCents, r.current.totals.clawbackCents, r.current.totals.netCents, r.current.totals.paidCents, r.current.totals.unpaidCents].map(money)]] : []),
          ],
        },
      ];
    }
  }
}

/** MRR is monthly by nature: the 12 months ending with the selected period (or today, if it's still running). */
export async function mrrTrend(p: Period, now: Date) {
  const lastMonth = periodOf("month", new Date(Math.min(p.end.getTime() - 1, now.getTime())), p.tz);
  const rows = await activeAndMrr(lastMonth, 12);
  const months = bucketsBetween(lastMonth, 12);
  return rows.map((r, i) => ({ ...r, label: periodLabel(months[i], now), period: months[i] }));
}

export async function buildTables(key: ReportKey, p: Period, now: Date = new Date()): Promise<Table[]> {
  if (key !== "all") return tablesFor(key, p, now);
  const all = await Promise.all(REPORTS.map((r) => tablesFor(r.key, p, now)));
  return all.flat();
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function toCsv(tables: Table[]): string {
  const cell = (v: string) => {
    // Plain amounts like "-$100.00" or "-12.5%" stay numbers; anything else a spreadsheet could run gets an apostrophe.
    const norm = v.replace(/^−/, "-");
    const numeric = /^-?\$?[\d,]+(\.\d+)?%?$/.test(norm);
    const safe = !numeric && /^[=+\-@\t\r]/.test(norm) ? `'${norm}` : norm;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines: string[] = [];
  tables.forEach((t, i) => {
    if (i > 0) lines.push("");
    lines.push(cell(t.title), t.columns.map(cell).join(","), ...t.rows.map((r) => r.map(cell).join(",")));
  });
  return lines.join("\r\n") + "\r\n";
}

/** The standard PDF fonts only cover Windows-1252; swap common Unicode punctuation for safe equivalents. */
export const ansi = (s: string) =>
  s.replace(/[−–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, "*").replace(/…/g, "...").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = ansi(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
}

/** A plain, printable PDF of the report tables (letter size, page breaks as needed). */
export async function toPdf(title: string, subtitle: string, tables: Table[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${title} - ${subtitle}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H, M] = [612, 792, 40];
  const ink = rgb(0.106, 0.122, 0.141);
  const muted = rgb(0.357, 0.396, 0.451);
  const line = rgb(0.89, 0.9, 0.918);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M) newPage(); };

  page.drawText(ansi(title), { x: M, y: y - 16, size: 16, font: bold, color: ink });
  y -= 22;
  page.drawText(ansi(`${subtitle} · generated ${new Date().toISOString().slice(0, 10)}`), { x: M, y: y - 10, size: 9, font, color: muted });
  y -= 26;

  for (const t of tables) {
    need(48);
    page.drawText(fit(t.title, bold, 11, W - 2 * M), { x: M, y: y - 11, size: 11, font: bold, color: ink });
    y -= 20;
    const n = t.columns.length;
    const first = n > 1 ? Math.min(220, (W - 2 * M) * 0.4) : W - 2 * M;
    const rest = n > 1 ? (W - 2 * M - first) / (n - 1) : 0;
    const xs = t.columns.map((_, i) => (i === 0 ? M : M + first + (i - 1) * rest));
    const widths = t.columns.map((_, i) => (i === 0 ? first : rest) - 6);
    const row = (cells: string[], f: PDFFont, color = ink) => {
      need(16);
      cells.forEach((c, i) => page.drawText(fit(c, f, 9, widths[i]), { x: xs[i], y: y - 9, size: 9, font: f, color }));
      y -= 14;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.5, color: line });
    };
    row(t.columns, bold, muted);
    if (t.rows.length === 0) row(["None in this period", ...Array(n - 1).fill("")], font, muted);
    for (const r of t.rows) row(r, font);
    y -= 14;
  }
  return doc.save();
}
