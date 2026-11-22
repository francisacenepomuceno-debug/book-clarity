import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { markContinuing, markEnded } from "@/ace/continuation";
import { refreshClientStatus } from "@/stripe/clientStatusSync";
import { dashboardAlerts } from "@/reports/alerts";
import { deriveClientStatus, STATUS_LABEL } from "@/domain/clientStatus";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
vi.mock("@/notify/send", () => ({ sendNotice: vi.fn(async () => "SENT") }));
const stripe = {
  customers: { create: vi.fn(async () => ({ id: "cus_new" })), retrieve: vi.fn(async (id: string) => ({ id })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs", url: "https://checkout.stripe.test/cs" })), expire: vi.fn(async () => ({})) } },
};
vi.mock("@/stripe/client", () => ({ getStripe: () => stripe }));
const as = (role: string) => (sessionRef.current = { user: { id: "u1", email: "u@bc.test", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

const DAY = 86400_000;
const now = new Date();
let pkg = "";

/** An ACE client in a slot whose prepaid time ended `daysAgo` days ago (negative: still prepaid). */
async function aceClient(name: string, daysAgo: number) {
  const until = new Date(now.getTime() - daysAgo * DAY);
  const c = await db.client.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@x.test`, type: "ACE", status: "PREPAID_ACE", acePrepaidUntil: until, packageId: pkg } });
  const b = await db.aceBatch.create({ data: { purchasedAt: now, totalCents: 1, createdById: "u1", paidAt: now } });
  const s = await db.aceSlot.create({ data: { batchId: b.id, packageId: pkg, clientId: c.id, startDate: now, prepaidUntil: until } });
  await db.client.update({ where: { id: c.id }, data: { aceSlotId: s.id } });
  return c.id;
}
const aceEndedAlert = async () => (await dashboardAlerts(now)).find((g) => g.kind === "aceEnded")?.items.map((i) => i.name) ?? [];

beforeEach(async () => {
  await resetDb();
  await db.user.create({ data: { id: "u1", email: "u@bc.test", name: "U", role: "OWNER" } });
  pkg = (await db.package.create({ data: { name: "Essentials", monthlyPriceCents: 35000, onboardingFeeCents: 0, stripePriceId: "price_e" } })).id;
  as("OWNER");
  process.env.PORTAL_BASE_URL = "https://portal.test";
});

describe("ACE clients whose prepaid time ended with no decision", () => {
  it("pure: awaiting decision after the prepaid time, never while it's still running", () => {
    const base = { type: "ACE" as const, endedAt: null, paused: false, onboardingComplete: true, continuingAwaitingPm: false, latestInvoice: null, now };
    expect(deriveClientStatus({ ...base, acePrepaidUntil: new Date(now.getTime() - DAY), aceAwaitingDecision: true })).toBe("ACE_AWAITING_DECISION");
    expect(deriveClientStatus({ ...base, acePrepaidUntil: new Date(now.getTime() + DAY), aceAwaitingDecision: true })).toBe("PREPAID_ACE");
    expect(STATUS_LABEL.ACE_AWAITING_DECISION).toBe("ACE ended: awaiting decision");
  });

  it("show as 'ACE ended: awaiting decision' (not Current) and stay on Needs attention until someone decides", async () => {
    const juke = await aceClient("Juke N Jive Braselton", 20);
    const prepaid = await aceClient("Still Prepaid", -40);
    expect(await refreshClientStatus(juke, now)).toBe("ACE_AWAITING_DECISION");
    expect(await refreshClientStatus(prepaid, now)).toBe("PREPAID_ACE");
    expect(await aceEndedAlert()).toEqual(["Juke N Jive Braselton"]);

    // Continuing: waiting for their payment method instead; off the list.
    expect((await markContinuing(juke, "https://portal.test")).ok).toBe(true);
    expect(await refreshClientStatus(juke, now)).toBe("CONTINUING_AWAITING_PM");
    expect(await aceEndedAlert()).toEqual([]);
  });

  it("Ending takes them off the list and ends them", async () => {
    const id = await aceClient("Juke N Jive Cumming", 5);
    expect(await aceEndedAlert()).toEqual(["Juke N Jive Cumming"]);
    expect((await markEnded(id)).ok).toBe(true);
    expect(await refreshClientStatus(id, new Date(now.getTime() + 1000))).toBe("ENDED");
    expect(await aceEndedAlert()).toEqual([]);
  });

  it("the Super Admin can record Continuing or Ending, like Owners; Admins can't", async () => {
    const a = await aceClient("Client A", 3);
    const b = await aceClient("Client B", 3);
    as("ADMIN");
    expect((await markContinuing(a, "https://portal.test")).ok).toBe(false);
    expect((await markEnded(b)).ok).toBe(false);
    as("SUPER_ADMIN");
    expect((await markContinuing(a, "https://portal.test")).ok).toBe(true);
    expect((await markEnded(b)).ok).toBe(true);
    expect(await aceEndedAlert()).toEqual([]);
  });
});
