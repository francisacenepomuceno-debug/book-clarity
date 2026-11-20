import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { parsePeriod } from "@/domain/periods";
import { REPORTS, buildTables, toCsv, toPdf } from "@/reports/export";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const nov = parsePeriod("month", "2026-11", "America/New_York");
beforeEach(async () => { await resetDb(); as("OWNER"); });

describe("CSV", () => {
  it("quotes cells and guards formula-looking text", () => {
    const csv = toCsv([{ title: "T", columns: ["Name", "Amount"], rows: [["Acme, \"Inc\"", "$1.00"], ["=HYPERLINK(1)", "-5"], ["@x", "+1"]] }]);
    expect(csv).toBe('"T"\r\n"Name","Amount"\r\n"Acme, ""Inc""","$1.00"\r\n"\'=HYPERLINK(1)","\'-5"\r\n"\'@x","\'+1"\r\n');
  });
});

describe("report tables", () => {
  it("every report builds a table with current and previous columns; 'all' builds them all", async () => {
    const c = await db.client.create({ data: { name: "Acme" } });
    await db.invoice.create({ data: { stripeInvoiceId: "in_1", clientId: c.id, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 65000, totalCents: 65000, amountPaidCents: 65000, paidAt: new Date("2026-11-10T15:00:00Z"), periodStart: new Date("2026-11-05T12:00:00Z"), periodEnd: new Date("2026-12-05T12:00:00Z") } });
    for (const r of REPORTS) {
      const t = await buildTables(r.key, nov);
      expect(t.length).toBeGreaterThan(0);
    }
    const rev = (await buildTables("revenue", nov))[0];
    expect(rev.columns).toEqual(["Revenue", "November 2026", "October 2026", "Change"]);
    expect(rev.rows[0]).toEqual(["Monthly packages", "$650.00", "$0.00", "new"]);
    expect((await buildTables("all", nov)).length).toBeGreaterThanOrEqual(REPORTS.length);
  });

  it("builds a PDF", async () => {
    const bytes = await toPdf("Book Clarity report", "November 2026", await buildTables("all", nov));
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe("%PDF");
  });
});

describe("export route", () => {
  it("Admins get 403 and Owners get the file", async () => {
    const { GET } = await import("@/app/api/reports/[report]/route");
    const req = (q: string) => new Request(`https://p/api/reports/revenue?${q}`);
    as("ADMIN");
    expect((await GET(req("period=month&key=2026-11&format=csv"), { params: Promise.resolve({ report: "revenue" }) })).status).toBe(403);
    as("OWNER");
    const ok = await GET(req("period=month&key=2026-11&format=csv"), { params: Promise.resolve({ report: "revenue" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/csv/);
    expect(ok.headers.get("content-disposition")).toMatch(/book-clarity-revenue-2026-11\.csv/);
    const pdf = await GET(req("period=month&key=2026-11&format=pdf"), { params: Promise.resolve({ report: "revenue" }) });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect((await GET(req("period=month&key=nope&format=csv"), { params: Promise.resolve({ report: "revenue" }) })).status).toBe(400);
    expect((await GET(req("period=month&key=2026-11&format=csv"), { params: Promise.resolve({ report: "secret" }) })).status).toBe(404);
  });
});
