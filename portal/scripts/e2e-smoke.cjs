/**
 * Browser smoke test against a running portal (default http://localhost:3000) with real Stripe data.
 * Read-only: it never submits a discount. Needs DATABASE_URL and SMOKE_SUPERADMIN_PASSWORD for
 * superadmin@bookclarity.local (created by prisma/seed.ts). Creates/updates an Admin test user.
 *   node scripts/e2e-smoke.cjs
 */
const { chromium } = require("playwright");
const { authenticator } = require("otplib");
const { PrismaClient } = require("@prisma/client");
const { randomBytes, scryptSync } = require("node:crypto");

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SA = "superadmin@bookclarity.local";
const ADMIN = "admin-smoke@bookclarity.local";
const W = { waitUntil: "commit" };
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
};

async function login(browser, email, password, totpSecret) {
  const p = await browser.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill("input[name=email]", email);
  await p.fill("input[name=password]", password);
  await p.click("button");
  if (totpSecret !== undefined) {
    await p.waitForURL("**/login/2fa", W);
    await p.waitForSelector("input[name=code]");
    await p.fill("input[name=code]", authenticator.generate(await totpSecret()));
    await p.click("form button");
  }
  await p.waitForSelector(".kpi", { timeout: 90000 });
  return p;
}

(async () => {
  const db = new PrismaClient();
  const browser = await chromium.launch();
  try {
    // Owner-level (Super Admin)
    await db.user.update({ where: { email: SA }, data: { totpEnabled: false, totpSecret: null } });
    const owner = await login(browser, SA, process.env.SMOKE_SUPERADMIN_PASSWORD, async () => (await db.user.findUnique({ where: { email: SA } })).totpSecret);
    check("super admin sees revenue", await owner.isVisible("text=Monthly package revenue"));
    const rows = await owner.locator("tbody tr").count();
    check("client list has rows", rows > 0, `${rows} rows`);
    const synced = await db.client.count({ where: { stripeSubscriptionId: { not: null } } });
    check("live clients synced into the portal DB", synced > 0, `${synced} clients`);
    await owner.locator("tbody tr td a").first().click();
    await owner.waitForSelector("h2", { timeout: 60000 });
    check("client page shows invoice history", await owner.isVisible("th:has-text('Invoice')"));
    check("client page shows discount form to owners", await owner.isVisible("text=Give a discount"));

    // Admin
    const pw = randomBytes(12).toString("hex");
    const salt = randomBytes(16);
    const passwordHash = `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
    await db.user.upsert({ where: { email: ADMIN }, update: { passwordHash, role: "ADMIN" }, create: { email: ADMIN, name: "Smoke Admin", role: "ADMIN", passwordHash } });
    const admin = await login(browser, ADMIN, pw);
    check("admin does not see revenue", !(await admin.isVisible("text=Monthly package revenue")));
    const tableText = await admin.locator("table").innerText();
    check("admin table has no dollar amounts", !tableText.includes("$"));
    check("admin table has no payment method column", !tableText.includes("Payment method"));
    await admin.locator("tbody tr td a").first().click();
    await admin.waitForSelector("h2", { timeout: 60000 });
    check("admin client page has no discount form", !(await admin.isVisible("text=Give a discount")));
    check("admin client page has no invoices", !(await admin.isVisible("th:has-text('Invoice')")));
  } finally {
    await browser.close();
    await db.$disconnect();
  }
  const failed = checks.filter((c) => !c).length;
  console.log(failed ? `${failed} check(s) failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE ERROR", e.message.split("\n")[0]);
  process.exit(1);
});
