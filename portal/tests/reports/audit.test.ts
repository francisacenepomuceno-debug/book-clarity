import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { changedKeys, listAudit } from "@/audit/list";
import { resetDb } from "../helpers/db";

const sessionRef: { current: unknown } = { current: null };
vi.mock("@/auth/current", () => ({ getCurrentSession: async () => sessionRef.current }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
const as = (role: string) => (sessionRef.current = { user: { id: "u", email: "u@x.co", name: "U", role, totpEnabled: true }, twoFactorVerified: true });

beforeEach(async () => {
  await resetDb();
  as("OWNER");
  await db.user.create({ data: { id: "jose", email: "j@x.co", name: "Jose", role: "OWNER" } });
  for (let i = 0; i < 5; i++) {
    await db.auditLog.create({ data: { actorId: i % 2 ? "jose" : null, action: i === 4 ? "discount_applied" : "client_suspended", entity: "Client", entityId: `c${i % 2}`, before: { a: 1, b: 2 }, after: { a: 1, b: 3, c: 4 }, at: new Date(Date.UTC(2026, 10, 20, 12, 0, i)) } });
  }
});

describe("audit log", () => {
  it("lists newest first with names, and pages without gaps or repeats", async () => {
    const first = await listAudit({ limit: 2 });
    expect(first.rows.map((r) => r.at.getUTCSeconds())).toEqual([4, 3]);
    expect(first.rows[1].actorName).toBe("Jose");
    expect(first.rows[0].actorName).toBe("System");
    const second = await listAudit({ limit: 2, cursor: first.next! });
    const third = await listAudit({ limit: 2, cursor: second.next! });
    expect([...first.rows, ...second.rows, ...third.rows].map((r) => r.at.getUTCSeconds())).toEqual([4, 3, 2, 1, 0]);
    expect(third.next).toBeNull();
  });

  it("filters by action, person and entity", async () => {
    expect((await listAudit({ action: "discount_applied" })).rows).toHaveLength(1);
    expect((await listAudit({ actorId: "jose" })).rows).toHaveLength(2);
    expect((await listAudit({ entityId: "c0" })).rows).toHaveLength(3);
    expect((await listAudit({})).actions).toEqual(["client_suspended", "discount_applied"]);
  });

  it("shows which keys changed", () => {
    expect(changedKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual(["b", "c"]);
    expect(changedKeys(null, { x: 1 })).toEqual(["x"]);
  });

  it("Admins can't read it", async () => {
    as("ADMIN");
    await expect(listAudit({})).rejects.toThrow(/Forbidden/);
  });
});
