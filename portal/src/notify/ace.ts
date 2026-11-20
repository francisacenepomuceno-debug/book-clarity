import { db } from "@/lib/db";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";
import { continuationToken } from "@/ace/continuation";
import { getAceContactEmail } from "@/ace/batches";
import { CONTINUATION_REMINDER_DAYS } from "@/domain/ace";
import { signLink } from "@/lib/links";
import { formatUsd } from "@/lib/money";
import { fmtDate } from "@/lib/format";

const DAY = 86400_000;
const BATCH_REMINDER_DAYS = [7, 14] as const;

/**
 * Daily: tell ACE clients their prepaid period is ending (60, then 30 and 14 days before) until they say Yes
 * or an Owner decides; alert Owners when a period has ended with no decision.
 */
export async function runAceNotices(now: Date = new Date()): Promise<{ clientNotices: number; ownerAlerts: number }> {
  const clients = await db.client.findMany({
    where: {
      type: "ACE",
      stripeSubscriptionId: null,
      acePrepaidUntil: { not: null },
      aceSlotId: { not: null },
      // `not: "ENDING"` alone would also drop clients with no decision yet (SQL NULL), i.e. most of them.
      OR: [{ continuationDecision: null }, { continuationDecision: { not: "ENDING" } }],
    },
  });
  const owners = await db.user.findMany({ where: { role: { in: ["OWNER", "SUPER_ADMIN"] } } });
  let clientNotices = 0;
  let ownerAlerts = 0;
  for (const c of clients) {
    const msLeft = c.acePrepaidUntil!.getTime() - now.getTime();
    if (msLeft >= 0) {
      if (c.clientAnswer === "YES" || c.continuationDecision === "CONTINUING") continue;
      const daysLeft = Math.ceil(msLeft / DAY);
      // The latest notice that's due (a client added late gets one notice, not a burst).
      const due = [...CONTINUATION_REMINDER_DAYS].reverse().find((d) => daysLeft <= d);
      if (!due) continue;
      const t = templates.aceProgramEnding({
        name: c.name,
        endDate: fmtDate(c.acePrepaidUntil),
        daysLeft,
        continueUrl: `${baseUrl()}/continue/${continuationToken(c.id)}`,
      });
      await sendNotice({
        key: `ace-ending:${c.id}:${due}`,
        kind: `ace_ending_${due}`,
        clientId: c.id,
        to: { name: c.name, email: c.email, phone: c.phone, ghlContactId: c.ghlContactId },
        email: { subject: t.subject, html: t.html },
        sms: t.sms,
      });
      clientNotices++;
    } else if (c.continuationDecision !== "CONTINUING") {
      const t = templates.ownerAceNoDecision({ clientName: c.name, endDate: fmtDate(c.acePrepaidUntil), clientUrl: `${baseUrl()}/clients/${c.id}` });
      for (const o of owners) {
        await sendNotice({ key: `ace-no-decision:${c.id}:${o.id}`, kind: "owner_ace_no_decision", to: { name: o.name, email: o.email }, email: { subject: t.subject, html: t.html } });
        ownerAlerts++;
      }
    }
  }
  return { clientNotices, ownerAlerts };
}

/** Daily: remind ACE's billing contact about unpaid batch invoices 7 and 14 days after they were sent. */
export async function runAceBatchReminders(now: Date = new Date()): Promise<number> {
  const email = await getAceContactEmail();
  if (!email) return 0;
  const batches = await db.aceBatch.findMany({ where: { paidAt: null, invoiceSentAt: { not: null } } });
  let n = 0;
  for (const b of batches) {
    const days = Math.floor((now.getTime() - b.invoiceSentAt!.getTime()) / DAY);
    const due = [...BATCH_REMINDER_DAYS].reverse().find((d) => days >= d);
    if (!due) continue;
    const t = templates.aceBatchUnpaid({
      amount: formatUsd(b.totalCents),
      sentOn: fmtDate(b.invoiceSentAt),
      payUrl: `${baseUrl()}/pay/ace/${signLink("ace-card-pay", b.id)}`,
    });
    await sendNotice({ key: `ace-batch:${b.id}:${due}`, kind: `ace_batch_unpaid_${due}`, to: { name: "ACE", email }, email: { subject: t.subject, html: t.html }, sms: undefined });
    n++;
  }
  return n;
}
