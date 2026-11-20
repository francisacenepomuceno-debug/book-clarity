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
      AND: [
        { OR: [{ continuationDecision: null }, { continuationDecision: { not: "ENDING" } }] },
        { OR: [{ endedAt: null }, { endedAt: { gt: now } }] },
      ],
    },
  });
  const owners = await db.user.findMany({ where: { role: { in: ["OWNER", "SUPER_ADMIN"] } } });
  let clientNotices = 0;
  let ownerAlerts = 0;
  const to = (c: (typeof clients)[number]) => ({ name: c.name, email: c.email, phone: c.phone, ghlContactId: c.ghlContactId });
  const continueUrl = (id: string) => `${baseUrl()}/continue/${continuationToken(id)}`;
  const alertOwners = async (key: string, kind: string, t: { subject: string; html: string }) => {
    for (const o of owners) {
      await sendNotice({ key: `${key}:${o.id}`, kind, to: { name: o.name, email: o.email }, email: t });
      ownerAlerts++;
    }
  };

  for (const c of clients) {
    const msLeft = c.acePrepaidUntil!.getTime() - now.getTime();
    const continuing = c.continuationDecision === "CONTINUING";
    if (msLeft >= 0) {
      const daysLeft = Math.ceil(msLeft / DAY);
      if (continuing) {
        // Said yes but no payment method yet (spec D6): remind them to finish setup from 14 days out.
        if (daysLeft > 14) continue;
        const t = templates.aceSetupReminder({ name: c.name, endDate: fmtDate(c.acePrepaidUntil), continueUrl: continueUrl(c.id) });
        await sendNotice({ key: `ace-setup:${c.id}:14`, kind: "ace_setup_14", clientId: c.id, to: to(c), email: { subject: t.subject, html: t.html }, sms: t.sms });
        clientNotices++;
        continue;
      }
      if (c.clientAnswer === "YES") continue;
      // The latest notice that's due (a client added late gets one notice, not a burst).
      const due = [...CONTINUATION_REMINDER_DAYS].reverse().find((d) => daysLeft <= d);
      if (!due) continue;
      const t = templates.aceProgramEnding({ name: c.name, endDate: fmtDate(c.acePrepaidUntil), daysLeft, continueUrl: continueUrl(c.id) });
      await sendNotice({ key: `ace-ending:${c.id}:${due}`, kind: `ace_ending_${due}`, clientId: c.id, to: to(c), email: { subject: t.subject, html: t.html }, sms: t.sms });
      clientNotices++;
    } else if (continuing) {
      const t = templates.ownerAceAwaitingPm({ clientName: c.name, endDate: fmtDate(c.acePrepaidUntil), clientUrl: `${baseUrl()}/clients/${c.id}` });
      await alertOwners(`ace-awaiting-pm:${c.id}`, "owner_ace_awaiting_pm", { subject: t.subject, html: t.html });
    } else {
      const t = templates.ownerAceNoDecision({ clientName: c.name, endDate: fmtDate(c.acePrepaidUntil), clientUrl: `${baseUrl()}/clients/${c.id}` });
      await alertOwners(`ace-no-decision:${c.id}`, "owner_ace_no_decision", { subject: t.subject, html: t.html });
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
