import { db } from "@/lib/db";
import { runPaymentReminders } from "@/notify/payments";
import { runAceBatchReminders, runAceNotices } from "@/notify/ace";
import { runOnboardingReminders } from "@/onboarding/reminders";
import { runSuspensions } from "@/billing/suspension";

async function safely<T>(name: string, f: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await f();
  } catch (e) {
    console.error(`[daily] ${name} failed:`, (e as Error).message);
    return { error: (e as Error).message };
  }
}

/** Everything date-based, once a day (Vercel Cron). Each part is idempotent and isolated from the others. */
export async function runDaily(now: Date = new Date()) {
  const payments = await safely("payments", () => runPaymentReminders(now));
  const ace = await safely("ace", () => runAceNotices(now));
  const aceBatches = await safely("aceBatches", () => runAceBatchReminders(now));
  const onboarding = await safely("onboarding", () => runOnboardingReminders(now));
  // After the reminders, so a client gets the day-14 notice etc. before being suspended.
  const suspensions = await safely("suspensions", () => runSuspensions(now));
  // Notices that started sending but never finished (process died); they're not retried blindly
  // because the message may have gone out — surfaced here instead.
  const stuckNotices = await db.notification.count({ where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - 3600_000) } } });
  if (stuckNotices > 0) console.warn(`[daily] ${stuckNotices} notice(s) stuck mid-send; check the Notification log`);
  return { payments, ace, aceBatches, onboarding, suspensions, stuckNotices };
}
