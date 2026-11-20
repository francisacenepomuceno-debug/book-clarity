import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ghlConfigured, ghlSendMessage, ghlUpsertContact } from "@/ghl/client";

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

  if (!ghlConfigured()) {
    await finish("SKIPPED", { error: "GHL not configured" });
    return "SKIPPED";
  }
  const channels = [n.email && n.to.email ? "email" : null, n.sms && n.to.phone ? "sms" : null].filter(Boolean) as string[];
  if (channels.length === 0) {
    await finish("SKIPPED", { error: "no contact details" });
    return "SKIPPED";
  }

  try {
    let contactId = n.to.ghlContactId ?? null;
    if (!contactId) {
      contactId = await ghlUpsertContact({ name: n.to.name, email: n.to.email, phone: n.to.phone });
      if (n.clientId) await db.client.updateMany({ where: { id: n.clientId }, data: { ghlContactId: contactId } });
    }
    if (channels.includes("email")) await ghlSendMessage({ contactId, type: "Email", subject: n.email!.subject, html: n.email!.html });
    if (channels.includes("sms")) await ghlSendMessage({ contactId, type: "SMS", message: n.sms! });
    await finish("SENT", { channels: channels.join(",") });
    return "SENT";
  } catch (e) {
    console.error(`[notify] ${n.key} failed:`, (e as Error).message);
    await finish("FAILED", { error: (e as Error).message.slice(0, 500), channels: channels.join(",") });
    return "FAILED";
  }
}
