import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { monthlyPayments } from "@/payments/monthly";
import { resetDb } from "../helpers/db";

const d = (s: string) => new Date(s);
let n = 0;
const inv = (clientId: string, o: Record<string, unknown>) =>
  db.invoice.create({ data: { stripeInvoiceId: `in_${++n}`, clientId, status: "paid", kind: "SUBSCRIPTION", subtotalCents: 65000, totalCents: 65000, periodStart: d("2026-11-05T12:00:00Z"), periodEnd: d("2026-12-05T12:00:00Z"), billedAt: (o.billedAt ?? o.periodStart ?? d("2026-11-05T12:00:00Z")) as Date, ...o } });

beforeEach(async () => { await resetDb(); n = 0; });

describe("payments view", () => {
  it("shows each client's monthly bills with a status; Owners get amounts and methods, Admins don't", async () => {
    const a = await db.client.create({ data: { name: "Paid Co", stripeSubscriptionId: "sub_a" } });
    await inv(a.id, { amountPaidCents: 65000, paidAt: d("2026-11-05T13:00:00Z"), paymentMethodType: "card", cardFunding: "credit" });
    const b = await db.client.create({ data: { name: "Failed Co" } });
    await inv(b.id, { status: "open", firstFailedAt: d("2026-11-05T13:00:00Z") });
    const c = await db.client.create({ data: { name: "Bank Co" } });
    await inv(c.id, { status: "open", processingSince: d("2026-11-05T13:00:00Z") });
    const s = await db.client.create({ data: { name: "Held Co", suspendedAt: d("2026-11-10T13:00:00Z") } });
    await inv(s.id, { status: "open", firstFailedAt: d("2026-10-05T13:00:00Z") });
    // billed twice in one month (e.g. after a plan change)
    await inv(a.id, { status: "open", periodStart: d("2026-11-20T12:00:00Z") });
    await inv(a.id, { status: "void" });
    await db.client.create({ data: { name: "Ace Co", type: "ACE", acePrepaidUntil: d("2027-03-01T12:00:00Z") } });
    await db.client.create({ data: { name: "Ace Ended", type: "ACE", acePrepaidUntil: d("2026-09-01T12:00:00Z") } });

    const owner = await monthlyPayments("2026-11", "OWNER");
    expect(owner.rows.map((r) => [r.name, r.status])).toEqual([
      ["Ace Co", "PREPAID_ACE"],
      ["Bank Co", "PROCESSING"],
      ["Failed Co", "FAILED"],
      ["Held Co", "SUSPENDED"],
      ["Paid Co", "PAID"],
      ["Paid Co", "OPEN"],
    ]);
    expect(owner.rows.find((r) => r.status === "PAID")).toMatchObject({ amountCents: 65000, method: "Credit card", href: "/clients/sub_a" });
    expect(owner.counts).toEqual({ PAID: 1, FAILED: 1, PROCESSING: 1, OPEN: 1, SUSPENDED: 1, PREPAID_ACE: 1 });

    const admin = await monthlyPayments("2026-11", "ADMIN");
    for (const r of admin.rows) {
      expect(r).not.toHaveProperty("amountCents");
      expect(r).not.toHaveProperty("method");
    }
    expect(JSON.stringify(admin)).not.toMatch(/65000|Credit/);
  });

  it("rejects a bad month", async () => {
    await expect(monthlyPayments("2026-13", "OWNER")).rejects.toThrow();
  });
});
