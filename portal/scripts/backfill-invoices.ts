/**
 * Read-only: copies past Stripe invoices into the portal so reports have history. Safe to run again.
 * Run it once after the clients have been synced (open the dashboard once, or run the Plan 6 import).
 *
 *   npx tsx scripts/backfill-invoices.ts [--since 2025-01-01]
 */
import { getStripe } from "../src/stripe/client";
import { backfillInvoices } from "../src/stripe/backfill";

const i = process.argv.indexOf("--since");
const since = new Date(i > 0 ? process.argv[i + 1] : "2025-01-01");
if (Number.isNaN(since.getTime())) throw new Error("Usage: npx tsx scripts/backfill-invoices.ts [--since YYYY-MM-DD]");
backfillInvoices(getStripe(), since)
  .then((r) => console.log(`Invoices since ${since.toISOString().slice(0, 10)}: ${r.seen} seen, ${r.stored} stored, ${r.skipped} skipped (not portal clients).`))
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => process.exit(0));
