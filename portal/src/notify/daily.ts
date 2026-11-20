import { runPaymentReminders } from "@/notify/payments";
import { runAceBatchReminders, runAceNotices } from "@/notify/ace";

/** Everything date-based, once a day (Vercel Cron). Each part is idempotent. */
export async function runDaily(now: Date = new Date()) {
  const payments = await runPaymentReminders(now);
  const ace = await runAceNotices(now);
  const aceBatches = await runAceBatchReminders(now);
  return { payments, ace, aceBatches };
}
