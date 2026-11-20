import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ghlConfigured, ghlSendMessage, ghlUpsertContact } from "@/ghl/client";
import { looksLikeName } from "@/notify/templates";

export const MAX_ATTEMPTS = 2;

export type Notice = {
  /** Unique per notice, e.g. `failed:<invoice>:3`. A key is sent at most once. */
  key: string;
  kind: string;
  clientId?: string;
  to: { name: string; email?: string | null; phone?: string | null; ghlContactId?: string | null };
  email?: { subject: string; html: string };
  sms?: string;
};

export type SendResult = "SENT" | "SKIPPED" | "FAILED" | "DUPLICATE";

/** Claims the key: a new row, or a FAILED row that still has a retry left. */
async function claim(n: Notice): Promise<boolean> {
  const to = [n.to.email, n.to.phone].filter(Boolean).join(" / ") || null;
  try {
    await db.notification.create({ data: { key: n.key, kind: n.kind, clientId: n.clientId ?? null, to, status: "PENDING" } });
    return true;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const retried = await db.notification.updateMany({
      where: { key: n.key, status: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
      data: { status: "PENDING" },
    });
    return retried.count === 1;
  }
}

/** Sends a notice through GHL (email and/or SMS). Never throws; always leaves a log row. */
export async function sendNotice(n: Notice): Promise<SendResult> {
  try {
    return await sendNoticeInner(n);
  } catch (e) {
    console.error(`[notify] ${n.key} could not be recorded:`, (e as Error).message);
    return "FAILED";
  }
}

async function sendNoticeInner(n: Notice): Promise<SendResult> {
  if (!(await claim(n))) return "DUPLICATE";
  const finish = (status: "SENT" | "SKIPPED" | "FAILED", extra: { error?: string; channels?: string } = {}) =>
    db.notification.update({
      where: { key: n.key },
      data: {
        status,
        error: extra.error ?? null,
        channels: extra.channels ?? "",
        ...(status === "FAILED" ? { attempts: { increment: 1 } } : {}),
        ...(status === "SENT" ? { sentAt: new Date() } : {}),
      },
    });

  if (process.env.NODE_ENV === "production" && !process.env.PORTAL_BASE_URL) {
    await finish("SKIPPED", { error: "PORTAL_BASE_URL not set (links would be wrong)" });
    return "SKIPPED";
  }
  if (!ghlConfigured()) {
    await finish("SKIPPED", { error: "GHL not configured" });
    return "SKIPPED";
  }
  const channels = [n.email && n.to.email ? "email" : null, n.sms && n.to.phone ? "sms" : null].filter(Boolean) as string[];
  if (channels.length === 0) {
    await finish("SKIPPED", { error: "no contact details" });
    return "SKIPPED";
  }

  let contactId = n.to.ghlContactId ?? null;
  try {
    if (!contactId) {
      // Never overwrite a contact's real name in GHL with a placeholder or an email address.
      contactId = await ghlUpsertContact({ ...(looksLikeName(n.to.name) ? { name: n.to.name } : {}), email: n.to.email, phone: n.to.phone });
      if (n.clientId) await db.client.updateMany({ where: { id: n.clientId }, data: { ghlContactId: contactId } });
    }
  } catch (e) {
    await finish("FAILED", { error: `contact: ${(e as Error).message}`.slice(0, 500) });
    return "FAILED";
  }

  // Each channel separately: if email went out but SMS failed, the notice counts as sent (no duplicate email on retry).
  const ok: string[] = [];
  const errors: string[] = [];
  for (const ch of channels) {
    try {
      if (ch === "email") await ghlSendMessage({ contactId, type: "Email", subject: n.email!.subject, html: n.email!.html });
      else await ghlSendMessage({ contactId, type: "SMS", message: n.sms! });
      ok.push(ch);
    } catch (e) {
      errors.push(`${ch}: ${(e as Error).message}`);
    }
  }
  if (ok.length > 0) {
    await finish("SENT", { channels: ok.join(","), error: errors.length ? errors.join("; ").slice(0, 500) : undefined });
    return "SENT";
  }
  console.error(`[notify] ${n.key} failed:`, errors.join("; "));
  await finish("FAILED", { error: errors.join("; ").slice(0, 500), channels: channels.join(",") });
  return "FAILED";
}
