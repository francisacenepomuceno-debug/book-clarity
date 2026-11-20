import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { countersign } from "@/onboarding/countersign";
import { contractCopyLink, executedContractPdf, signedContracts } from "@/onboarding/contractCopies";
import { saveOnboardingSettings, getOnboardingSettings } from "@/settings/onboarding";
import { resetDb } from "../helpers/db";

const ghl = vi.hoisted(() => ({ upsert: vi.fn(), send: vi.fn() }));
vi.mock("@/ghl/client", () => ({ ghlConfigured: () => true, ghlUpsertContact: ghl.upsert, ghlSendMessage: ghl.send, GhlError: class extends Error {} }));
const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string, id = "jose", name = "Jose Owner", email = "jose@book-clarity.test") =>
  (sessionRef.current = { user: { id, email, name, role, totpEnabled: true }, twoFactorVerified: true });

const now = new Date("2026-11-20T15:00:00Z");
const SIGNED = "Agreement for Acme LLC\nFee $500.00 – monthly $650.00 “Growth”\nSigned electronically by Jane Doe on November 20, 2026\nAwaiting countersignature by Book Clarity, LLC\n";

async function signed() {
  await db.user.create({ data: { id: "jose", email: "jose@book-clarity.test", name: "Jose Owner", role: "OWNER" } });
  const c = await db.client.create({ data: { name: "Acme LLC", email: "jane@acme.co" } });
  return db.onboarding.create({ data: { clientId: c.id, details: {}, signedAt: now, signerName: "Jane Doe", signerIp: "203.0.113.9", signedText: SIGNED, signedHash: "abc123", contractVersion: "v1" } });
}

beforeEach(async () => {
  await resetDb();
  as("OWNER");
  ghl.upsert.mockReset().mockResolvedValue("ct");
  ghl.send.mockReset().mockResolvedValue("m");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("fully signed copies", () => {
  it("go to the client, the countersigner and the office copy address, each once, with a PDF link", async () => {
    const o = await signed();
    expect(await countersign(o.id, now)).toEqual({ ok: true });
    const notes = await db.notification.findMany({ orderBy: { key: "asc" } });
    expect(notes.map((n) => [n.key, n.to])).toEqual([
      [`contract-executed-copy:${o.id}`, "info@book-clarity.com"],
      [`contract-executed-staff:${o.id}:jose`, "jose@book-clarity.test"],
      [`contract-executed:${o.id}`, "jane@acme.co"],
    ]);
    const html = (ghl.send.mock.calls.find((c) => (c[0] as { html?: string }).html?.includes("Hi Acme"))![0] as { html: string }).html;
    expect(html).toContain(contractCopyLink(o.id, "https://portal.test"));
  });

  it("the office copy address is a setting (default info@book-clarity.com), and can be turned off", async () => {
    expect((await getOnboardingSettings()).contractCopyEmail).toBe("info@book-clarity.com");
    as("OWNER");
    expect((await saveOnboardingSettings({ ...(await getOnboardingSettings()), contractCopyEmail: "not-an-email" })).ok).toBe(false);
    expect((await saveOnboardingSettings({ ...(await getOnboardingSettings()), contractCopyEmail: "" })).ok).toBe(true);
    const o = await signed();
    await countersign(o.id, now);
    expect((await db.notification.findMany()).map((n) => n.key)).not.toContain(`contract-executed-copy:${o.id}`);
  });

  it("the PDF is built from the stored signed text, with both signatures and the signing record", async () => {
    const o = await signed();
    expect(await executedContractPdf(o.id)).toBeNull(); // not countersigned yet
    await countersign(o.id, now);
    const pdf = await executedContractPdf(o.id);
    expect(Buffer.from(pdf!.bytes.slice(0, 4)).toString()).toBe("%PDF");
    expect(pdf!.filename).toBe("Book-Clarity-agreement-Acme-LLC-2026-11-20.pdf");
    expect(pdf!.lines.join("\n")).toMatch(/Signed electronically by Jose Owner for Book Clarity, LLC/);
    expect(pdf!.lines.join("\n")).toMatch(/IP 203\.0\.113\.9/);
    expect(pdf!.lines.join("\n")).toMatch(/abc123/);
  });

  it("lists every signed agreement for Owners, newest first; Admins can't", async () => {
    const o = await signed();
    await countersign(o.id, now);
    const list = await signedContracts();
    expect(list.map((x) => [x.clientName, x.status])).toEqual([["Acme LLC", "Fully signed"]]);
    as("ADMIN", "al", "Al");
    await expect(signedContracts()).rejects.toThrow(/Forbidden/);
  });
});

describe("download links", () => {
  it("the emailed link downloads the PDF; a tampered link doesn't; the staff download is Owners-only", async () => {
    const o = await signed();
    await countersign(o.id, now);
    const pub = await import("@/app/contracts/copy/[token]/route");
    const token = contractCopyLink(o.id, "https://p").split("/contracts/copy/")[1];
    const ok = await pub.GET(new Request("https://p"), { params: Promise.resolve({ token }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    expect((await pub.GET(new Request("https://p"), { params: Promise.resolve({ token: token + "x" }) })).status).toBe(404);
    const staff = await import("@/app/contracts/[onboardingId]/pdf/route");
    expect((await staff.GET(new Request("https://p"), { params: Promise.resolve({ onboardingId: o.id }) })).status).toBe(200);
    as("ADMIN", "al", "Al");
    expect((await staff.GET(new Request("https://p"), { params: Promise.resolve({ onboardingId: o.id }) })).status).toBe(403);
  });
});
