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
    ? `<p style="margin:18px 0"><a href="${esc(button.url)}" style="background:#1f2386;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${esc(button.label)}</a></p><p style="margin:0 0 14px;font-size:12px;color:#5b6573">Or open this link: ${esc(button.url)}</p>`
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

  countersignRequest(i: { name: string; clientName: string; packageName: string; url: string }): Message {
    return {
      subject: `Countersign: ${i.clientName} signed the ${i.packageName} agreement`,
      html: html(
        [`Hi ${esc(firstName(i.name))},`, `<strong>${esc(i.clientName)}</strong> just signed their ${esc(i.packageName)} agreement. Please review and countersign it.`],
        { label: "Review and countersign", url: i.url },
      ),
      sms: sms(`${i.clientName} signed their agreement. Countersign: ${i.url}`),
    };
  },

  onboardingFeeFailed(i: { name: string; amount: string; url: string }): Message {
    return {
      subject: "Your Book Clarity onboarding fee didn't go through",
      html: html(
        [`Hi ${esc(firstName(i.name))},`, `Your onboarding fee payment of <strong>${esc(i.amount)}</strong> didn't go through. Please use your onboarding link to pay with another bank account or card.`],
        { label: "Pay onboarding fee", url: i.url },
      ),
      sms: sms(`Book Clarity: your onboarding fee of ${i.amount} didn't go through. Please try again: ${i.url}`),
    };
  },

  priceIncrease(i: { name: string; packageName: string; oldAmount: string; newAmount: string; startsOn: string }): Message {
    return {
      subject: "An update to your Book Clarity monthly price",
      html: html([
        `Hi ${esc(firstName(i.name))},`,
        `Thank you for being a Book Clarity client. We're writing to let you know that the monthly price of the <strong>${esc(i.packageName)}</strong> package is changing from <strong>${esc(i.oldAmount)}</strong> to <strong>${esc(i.newAmount)}</strong>.`,
        `The new price starts with your monthly payment on <strong>${esc(i.startsOn)}</strong>. Your services and payment method stay the same, and you don't need to do anything.`,
        `If you have any questions, just reply to this email and we'll be happy to help.`,
      ]),
      sms: sms(`Book Clarity: the monthly price of your ${i.packageName} package changes from ${i.oldAmount} to ${i.newAmount}, starting with your payment on ${i.startsOn}. Questions? Just reply.`),
    };
  },

  contractExecuted(i: { name: string; text: string; downloadUrl: string }): Message {
    return {
      subject: "Your signed Book Clarity agreement",
      html:
        html(
          [`Hi ${esc(firstName(i.name))},`, `Your agreement with Book Clarity has been countersigned. Download the signed PDF for your records; the full text is also below.`],
          { label: "Download signed agreement (PDF)", url: i.downloadUrl },
        ) +
        `<pre style="white-space:pre-wrap;font:13px/1.5 system-ui,sans-serif;background:#fafbfc;border:1px solid #e3e6ea;border-radius:8px;padding:14px;max-width:640px">${esc(i.text)}</pre>`,
      sms: sms(`Book Clarity: your agreement has been countersigned. We've emailed you a copy.`),
    };
  },

  contractExecutedCopy(i: { clientName: string; text: string; downloadUrl: string }): Message {
    return {
      subject: `Signed agreement: ${i.clientName}`,
      html:
        html([`The agreement with <strong>${esc(i.clientName)}</strong> is now signed by both parties. The PDF is also kept in the portal under Onboarding → Signed agreements.`], {
          label: "Download signed agreement (PDF)",
          url: i.downloadUrl,
        }) +
        `<pre style="white-space:pre-wrap;font:13px/1.5 system-ui,sans-serif;background:#fafbfc;border:1px solid #e3e6ea;border-radius:8px;padding:14px;max-width:640px">${esc(i.text)}</pre>`,
      sms: sms(`Signed agreement: ${i.clientName}. Download: ${i.downloadUrl}`),
    };
  },

  onboardingNudge(i: { name: string; step: string; url: string }): Message {
    return {
      subject: "Finish setting up with Book Clarity",
      html: html(
        [`Hi ${esc(firstName(i.name))},`, `You're part-way through getting set up with Book Clarity. Your next step is ${esc(i.step)}. It only takes a few minutes, and you can pick up right where you left off.`],
        { label: "Continue onboarding", url: i.url },
      ),
      sms: sms(`Book Clarity: you're almost set up! Next step: ${i.step}. Continue here: ${i.url}`),
    };
  },

  serviceSuspended(i: { name: string; amount: string; updateUrl: string }): Message {
    return {
      subject: "Your Book Clarity service is on hold",
      html: html(
        [
          `Hi ${esc(firstName(i.name))},`,
          `Because your payment of <strong>${esc(i.amount)}</strong> is still outstanding, we've put your Book Clarity service on hold.`,
          `As soon as the payment goes through, your service and monthly billing resume automatically. Paying by bank account (ACH) has no processing fee.`,
          `If you'd like to talk about it, just reply to this email.`,
        ],
        { label: "Update payment method", url: i.updateUrl },
      ),
      sms: sms(`Book Clarity: your service is on hold because your ${i.amount} payment is outstanding. Update your payment method to resume: ${i.updateUrl}`),
    };
  },

  staffClientSuspended(i: { clientName: string; amount: string; days: number; clientUrl: string }): Message {
    return {
      subject: `Suspended: ${i.clientName} (unpaid ${i.days} days)`,
      html: html(
        [`<strong>${esc(i.clientName)}</strong> has been suspended: ${esc(i.amount)} has been unpaid for ${i.days} days. Billing is paused; it resumes automatically when they pay, or an Owner can resume them from the client page.`],
        { label: "Open client", url: i.clientUrl },
      ),
      sms: sms(`${i.clientName} was suspended (unpaid ${i.days} days).`),
    };
  },
};
