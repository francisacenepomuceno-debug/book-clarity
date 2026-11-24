import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { launchStatus, loadInvoiceHistory } from "@/settings/launch";
import { resetDb } from "../helpers/db";

const backfill = vi.hoisted(() => vi.fn());
vi.mock("@/stripe/backfill", () => ({ backfillInvoices: backfill }));
vi.mock("@/clients/invoiceSubscriptions", () => ({ fillInvoiceSubscriptions: vi.fn(async () => 0) }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "sa", email: "sa@x.co", name: "SA", role, totpEnabled: true }, twoFactorVerified: true });

beforeEach(async () => {
  await resetDb();
  await db.setting.deleteMany({ where: { key: "launch" } });
  await db.user.create({ data: { id: "sa", email: "sa@x.co", name: "SA", role: "SUPER_ADMIN" } });
  backfill.mockReset().mockResolvedValue({ seen: 120, stored: 100, skipped: 20, clientsAdded: 3 });
});

describe("Load invoice history (Launch page)", () => {
  it("copies Stripe history from the chosen date and ticks the checklist", async () => {
    as("SUPER_ADMIN");
    const stripe = {} as never;
    const r = await loadInvoiceHistory("2025-01-01", { stripe });
    expect(r).toMatchObject({ ok: true, summary: expect.stringMatching(/100 invoices copied since 2025-01-01.*3 former clients/) });
    expect(backfill).toHaveBeenCalledWith(stripe, new Date("2025-01-01"));
    expect((await launchStatus()).manual.find((m) => m.key === "historyLoaded")?.done).toBe(true);
  });

  it("only the Super Admin, and only with a real date", async () => {
    as("OWNER");
    expect((await loadInvoiceHistory("2025-01-01", { stripe: {} as never })).ok).toBe(false);
    as("SUPER_ADMIN");
    expect(await loadInvoiceHistory("Jan 2025", { stripe: {} as never })).toMatchObject({ ok: false, error: expect.stringMatching(/YYYY-MM-DD/) });
    expect(backfill).not.toHaveBeenCalled();
  });
});
