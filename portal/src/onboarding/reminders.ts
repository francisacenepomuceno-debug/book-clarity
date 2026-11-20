import { db } from "@/lib/db";
import { nextStep, STEP_LABEL } from "@/domain/onboarding";
import { onboardingLink } from "@/onboarding/start";
import { getCountersigner } from "@/settings/onboarding";
import { sendNotice } from "@/notify/send";
import { templates } from "@/notify/templates";
import { baseUrl } from "@/notify/payments";

const DAY_MS = 86400_000;
export const NUDGE_AFTER_DAYS = 3;
export const COUNTERSIGN_REMINDER_DAYS = 2;

/** Daily: nudge clients with no onboarding progress for 3 days (once per step); remind the countersigner after 2 days. */
export async function runOnboardingReminders(now: Date = new Date()): Promise<{ nudges: number; countersignReminders: number }> {
  let nudges = 0;
  let countersignReminders = 0;
  const stuck = await db.onboarding.findMany({
    where: { completedAt: null, lastProgressAt: { lte: new Date(now.getTime() - NUDGE_AFTER_DAYS * DAY_MS) }, client: { endedAt: null } },
    include: { client: true },
  });
  for (const o of stuck) {
    const step = nextStep(o, o.client.type);
    if (step === "done") continue;
    const t = templates.onboardingNudge({ name: o.client.name, step: STEP_LABEL[step].toLowerCase(), url: onboardingLink(o.id) });
    const r = await sendNotice({ key: `onboarding-nudge:${o.id}:${step}`, kind: "onboarding-nudge", clientId: o.clientId, to: { name: o.client.name, email: o.client.email, phone: o.client.phone, ghlContactId: o.client.ghlContactId }, email: t, sms: t.sms });
    if (r === "SENT") nudges++;
  }

  const waiting = await db.onboarding.findMany({
    where: { countersignedAt: null, signedAt: { lte: new Date(now.getTime() - COUNTERSIGN_REMINDER_DAYS * DAY_MS) }, client: { endedAt: null } },
    include: { client: { include: { package: true } } },
  });
  const signer = waiting.length ? await getCountersigner() : null;
  for (const o of signer ? waiting : []) {
    const t = templates.countersignRequest({ name: signer!.name, clientName: o.client.name, packageName: o.client.package?.name ?? "package", url: `${baseUrl()}/contracts/${o.id}` });
    const r = await sendNotice({ key: `countersign-reminder:${o.id}:${signer!.id}`, kind: "countersign-reminder", to: { name: signer!.name, email: signer!.email }, email: { ...t, subject: `Reminder: ${o.client.name}'s agreement is waiting for your countersignature` } });
    if (r === "SENT") countersignReminders++;
  }
  return { nudges, countersignReminders };
}
