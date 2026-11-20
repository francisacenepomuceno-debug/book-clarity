import { runPaymentReminders } from "@/notify/payments";

/** Everything date-based, once a day (Vercel Cron). Each part is idempotent. */
export async function runDaily(now: Date = new Date()) {
  const payments = await runPaymentReminders(now);
  return { payments };
}
