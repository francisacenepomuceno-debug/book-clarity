/**
 * Browser smoke test against a running portal (default http://localhost:3000) with real Stripe data.
 * Read-only towards Stripe: it never submits a discount. LOCAL DATABASES ONLY: it reads the test Super Admin's
 * authenticator secret and creates an Admin test user, so it refuses any non-localhost DATABASE_URL.
 * Needs SMOKE_SUPERADMIN_PASSWORD for superadmin@bookclarity.local (create it with scripts/create-user.ts).
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
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    console.error(`Refusing to run against non-local database host "${host}".`);
    process.exit(2);
  }
  const db = new PrismaClient();
  const browser = await chromium.launch();
  try {
    // Owner-level (Super Admin)
    await db.user.update({ where: { email: SA }, data: { totpLastStep: null } }); // allow a fresh code each run
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
    check("owner sees the Commissions link", await owner.isVisible("header a[href='/commissions']"));
    const clientUrl = owner.url();
    await owner.goto(`${BASE}/commissions`);
    await owner.waitForSelector("h2");
    check("commissions page loads for owners", await owner.isVisible("text=Unpaid commission"));
    if (!(await owner.isVisible("li:has-text('Smoke Exec')"))) {
      await owner.fill("form.inline-form input[name=name]", "Smoke Exec");
      await owner.click("form.inline-form button");
      await owner.waitForSelector("li:has-text('Smoke Exec')");
    }
    check("owner can add an executive", await owner.isVisible("li:has-text('Smoke Exec')"));
    await owner.goto(clientUrl);
    await owner.waitForSelector("#commission");
    await owner.selectOption("#commission select[name=exec1]", { label: "Smoke Exec" });
    await owner.fill("#commission input[name=rate1]", "10");
    await owner.click("#commission button");
    await owner.waitForSelector("#commission .form-ok, #commission .form-error", { timeout: 60000 });
    check("owner can set a client's commission owner", await owner.isVisible("#commission .form-ok"));

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
    check("admin client page has no commission section", !(await admin.isVisible("#commission")));
    check("admin has no Commissions link", !(await admin.isVisible("header a[href='/commissions']")));
    await admin.goto(`${BASE}/commissions`);
    await admin.waitForLoadState("networkidle");
    check("admin cannot open the commissions page", !(await admin.isVisible("text=Unpaid commission")) && (await admin.isVisible("text=isn't available")));
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
