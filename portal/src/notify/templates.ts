/**
 * Client and Owner message copy (draft for Book Clarity's approval). Plain, warm, short; always signed Book Clarity.
 * Each returns an email subject + HTML body and an SMS (≤ 320 chars).
 */
export type Message = { subject: string; html: string; sms: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** First word of a real name; "there" for placeholders or email-looking names ("Hi there,"). */
export const looksLikeName = (name: string) => Boolean(name.trim()) && !name.includes("@") && !name.trim().startsWith("(");
const firstName = (name: string) => (looksLikeName(name) ? name.trim().split(/\s+/)[0] : "there");

function html(paragraphs: string[], button?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("");
  const btn = button
    ? `<p style="margin:18px 0"><a href="${esc(button.url)}" style="background:#1f4e79;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${esc(button.label)}</a></p><p style="margin:0 0 14px;font-size:12px;color:#5b6573">Or open this link: ${esc(button.url)}</p>`
    : "";
  return `<div style="font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1f24;max-width:560px">${body}${btn}<p style="margin:18px 0 0">Thank you,<br>Book Clarity</p></div>`;
}

const sms = (text: string) => (text.length <= 320 ? text : `${text.slice(0, 317)}...`);

export const templates = {
  upcomingCharge(i: { name: string; amount: string; date: string; updateUrl: string }): Message {
    return {
      subject: "Your Book Clarity payment is coming up",
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          `A friendly heads-up: your monthly Book Clarity payment of <strong>${esc(i.amount)}</strong> will be charged on <strong>${esc(i.date)}</strong>.`,
          `Nothing to do if your payment details are up to date. Paying by bank account (ACH) avoids the 3% card processing fee.`,
        ],
        { label: "Review payment method", url: i.updateUrl },
      ),
      sms: sms(`Book Clarity: your ${i.amount} payment will be charged on ${i.date}. Update your payment method: ${i.updateUrl}`),
    };
  },

  paymentFailed(i: { name: string; amount: string; day: 0 | 3 | 7 | 14; updateUrl: string }): Message {
    const lead =
      i.day === 0
        ? `We tried to charge <strong>${esc(i.amount)}</strong> for your Book Clarity service, but the payment didn't go through.`
        : i.day === 14
          ? `Your Book Clarity payment of <strong>${esc(i.amount)}</strong> is now two weeks overdue. Please update your payment details today so your bookkeeping can continue without interruption.`
          : `A reminder that your Book Clarity payment of <strong>${esc(i.amount)}</strong> is still outstanding.`;
    return {
      subject:
        i.day === 0
          ? "Your Book Clarity payment didn't go through"
          : i.day === 14
            ? "Action needed: your Book Clarity payment is overdue"
            : "Reminder: your Book Clarity payment is outstanding",
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          lead,
          `It only takes a minute to update your card or switch to bank account (ACH), which has no processing fee. We'll retry the payment automatically.`,
          `If you've already taken care of this, thank you and please ignore this message.`,
        ],
        { label: "Update payment method", url: i.updateUrl },
      ),
      sms: sms(
        i.day === 0
          ? `Book Clarity: your ${i.amount} payment didn't go through. Please update your card or switch to ACH (no fee): ${i.updateUrl}`
          : `Book Clarity reminder: your ${i.amount} payment is still outstanding. Update your payment method: ${i.updateUrl}`,
      ),
    };
  },

  ownerAtRisk(i: { clientName: string; amount: string; since: string; clientUrl: string }): Message {
    return {
      subject: `At risk: ${i.clientName} has been past due for 21 days`,
      html: html(
        [
          `<strong>${esc(i.clientName)}</strong> has an unpaid balance of <strong>${esc(i.amount)}</strong>, past due since ${esc(i.since)}.`,
          `Automatic reminders have gone out on day 0, 3, 7 and 14. It may be time for a personal call. Service is not paused automatically.`,
        ],
        { label: "Open client", url: i.clientUrl },
      ),
      sms: sms(`Book Clarity portal: ${i.clientName} is 21 days past due (${i.amount}). ${i.clientUrl}`),
    };
  },

  aceProgramEnding(i: { name: string; endDate: string; daysLeft: number; continueUrl: string }): Message {
    return {
      subject: i.daysLeft >= 60 ? "Your ACE-sponsored Book Clarity service ends soon" : `Reminder: your ACE-sponsored service ends on ${i.endDate}`,
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          `Your Book Clarity bookkeeping, paid for by ACE, ends on <strong>${esc(i.endDate)}</strong>.`,
          `We'd love to keep working with you. If you'd like to continue, you can set up monthly autopay directly with Book Clarity (by bank account or card) and your service carries on without a gap. Your first payment would be the day after your ACE period ends.`,
          `Please let us know either way using the link below: choose <strong>Yes, continue</strong> or <strong>No thanks</strong>.`,
        ],
        { label: "Let us know", url: i.continueUrl },
      ),
      sms: sms(`Book Clarity: your ACE-sponsored bookkeeping ends ${i.endDate}. Want to continue directly with us? Let us know: ${i.continueUrl}`),
    };
  },

  ownerAceNoDecision(i: { clientName: string; endDate: string; clientUrl: string }): Message {
    return {
      subject: `Decision needed: ${i.clientName}'s ACE period has ended`,
      html: html(
        [
          `<strong>${esc(i.clientName)}</strong>'s ACE-prepaid period ended on ${esc(i.endDate)}, and they aren't on autopay yet.`,
          `Please follow up and either mark them as continuing or confirm the end of service. The portal won't end their service on its own.`,
        ],
        { label: "Open client", url: i.clientUrl },
      ),
      sms: sms(`Book Clarity portal: ${i.clientName}'s ACE period ended ${i.endDate} with no decision. ${i.clientUrl}`),
    };
  },

  aceSetupReminder(i: { name: string; endDate: string; continueUrl: string }): Message {
    return {
      subject: "One last step to continue with Book Clarity",
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          `Thank you for choosing to continue with Book Clarity! To keep your bookkeeping going after your ACE period ends on <strong>${esc(i.endDate)}</strong>, please finish setting up your monthly payment (bank account with no fee, or card).`,
        ],
        { label: "Finish setup", url: i.continueUrl },
      ),
      sms: sms(`Book Clarity: please finish setting up your monthly payment before ${i.endDate} so your service continues: ${i.continueUrl}`),
    };
  },

  ownerAceAwaitingPm(i: { clientName: string; endDate: string; clientUrl: string }): Message {
    return {
      subject: `Follow up: ${i.clientName} is continuing but hasn't set up payment`,
      html: html(
        [
          `<strong>${esc(i.clientName)}</strong> chose to continue, but their ACE period ended on ${esc(i.endDate)} and no payment method has been saved yet, so nothing is being billed.`,
          `Please follow up with them.`,
        ],
        { label: "Open client", url: i.clientUrl },
      ),
      sms: sms(`Book Clarity portal: ${i.clientName} is continuing but has no payment method since ${i.endDate}. ${i.clientUrl}`),
    };
  },

  aceBatchUnpaid(i: { amount: string; sentOn: string; payUrl: string }): Message {
    return {
      subject: "Reminder: Book Clarity invoice for your client batch",
      html: html(
        [
          `Hello,`,
          `This is a reminder that the Book Clarity invoice for <strong>${esc(i.amount)}</strong>, sent on ${esc(i.sentOn)}, is still open.`,
          `You can pay by bank account (ACH, no fee) or by card using the link below.`,
        ],
        { label: "Pay invoice", url: i.payUrl },
      ),
      sms: sms(`Book Clarity: reminder that the ${i.amount} batch invoice sent ${i.sentOn} is still open. Pay here: ${i.payUrl}`),
    };
  },

  onboardingInvite(i: { name: string; url: string }): Message {
    return {
      subject: "Welcome to Book Clarity: let's get you set up",
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          `Welcome to Book Clarity! Getting started takes about 10 minutes: confirm your package and details, sign your agreement, pay the onboarding fee, answer a few questions about your business, and book your onboarding call.`,
          `You can stop at any point and pick up where you left off with the same link.`,
        ],
        { label: "Start onboarding", url: i.url },
      ),
      sms: sms(`Welcome to Book Clarity! Start your onboarding here: ${i.url}`),
    };
  },
};
