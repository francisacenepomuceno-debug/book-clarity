import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import { signatureBytes } from "@/domain/signature";
import { db } from "@/lib/db";
import { requirePermission } from "@/auth/permissions";
import { signLink, verifyLink } from "@/lib/links";
import { ansi } from "@/reports/export";
import { executedText } from "@/onboarding/countersign";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const PURPOSE = "contract-copy";
const when = (d: Date) => `${d.toLocaleString("en-US", { timeZone: TZ, dateStyle: "long", timeStyle: "short" })} (${TZ})`;

/** Non-expiring download link for the fully signed copy (sent to the client and staff). */
export const contractCopyLink = (onboardingId: string, base: string) => `${base}/contracts/copy/${signLink(PURPOSE, onboardingId)}`;
export const onboardingIdFromCopyToken = (token: string) => verifyLink(PURPOSE, token);

/**
 * The fully signed agreement as a PDF, rebuilt from what the portal stored when each party signed
 * (the exact text the client signed, its SHA-256 fingerprint, times, IP address and the countersigner).
 * Null until Book Clarity has countersigned.
 */
export async function executedContractPdf(onboardingId: string): Promise<{ bytes: Uint8Array; filename: string; lines: string[] } | null> {
  const o = await db.onboarding.findUnique({ where: { id: onboardingId }, include: { client: { include: { package: true } } } });
  if (!o?.signedText || !o.countersignedAt || !o.signedAt) return null;
  const by = o.countersignedById ? await db.user.findUnique({ where: { id: o.countersignedById } }) : null;
  const countersigner = by?.name ?? "Book Clarity, LLC";
  const body = executedText(o.signedText, countersigner, when(o.countersignedAt));
  const record = [
    "",
    "Signing record",
    `Client: signed electronically by ${o.signerName} (${o.signatureImage ? "drawn signature" : "typed name"}) on ${when(o.signedAt)}, from IP ${o.signerIp ?? "unknown"}.`,
    `Book Clarity, LLC: countersigned electronically by ${countersigner} (${o.countersignatureImage ? "drawn signature" : "typed name"}) on ${when(o.countersignedAt)}.`,
    `Contract version ${o.contractVersion ?? "—"}. SHA-256 fingerprint of the text the client signed: ${o.signedHash ?? "—"}`,
  ];
  const lines = [...body.split("\n"), ...record];

  const doc = await PDFDocument.create();
  doc.setTitle(`Book Clarity agreement - ${o.client.name}`);
  doc.setAuthor("Book Clarity, LLC");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H, M, size, lead] = [612, 792, 54, 10, 14];
  const ink = rgb(0.106, 0.122, 0.141);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const wrap = (text: string, f: PDFFont): string[] => {
    const words = ansi(text).split(/(\s+)/);
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      if (f.widthOfTextAtSize(cur + w, size) <= W - 2 * M) cur += w;
      else { if (cur.trim()) out.push(cur.trimEnd()); cur = w.trimStart(); }
    }
    out.push(cur.trimEnd());
    return out;
  };
  const draw = (text: string, f: PDFFont = font) => {
    for (const l of wrap(text, f)) {
      if (y - lead < M) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(l, { x: M, y: y - size, size, font: f, color: ink });
      y -= lead;
    }
  };
  page.drawText(ansi(`Book Clarity, LLC: client agreement`), { x: M, y: y - 14, size: 14, font: bold, color: ink });
  y -= 26;
  page.drawText(ansi(`${o.client.name}${o.client.package ? ` · ${o.client.package.name}` : ""}`), { x: M, y: y - size, size, font, color: rgb(0.357, 0.396, 0.451) });
  y -= 24;
  // Drawn signatures go right under their "Signed electronically by …" lines.
  const clientSig = o.signatureImage ? await doc.embedPng(signatureBytes(o.signatureImage)) : null;
  const providerSig = o.countersignatureImage ? await doc.embedPng(signatureBytes(o.countersignatureImage)) : null;
  const drawSig = (img: PDFImage) => {
    const h = 48;
    const w = Math.min(220, (img.width / img.height) * h);
    const hh = (w / ((img.width / img.height) * h)) * h;
    if (y - hh - 6 < M) { page = doc.addPage([W, H]); y = H - M; }
    page.drawImage(img, { x: M, y: y - hh, width: w, height: hh });
    page.drawLine({ start: { x: M, y: y - hh - 2 }, end: { x: M + 220, y: y - hh - 2 }, thickness: 0.6, color: ink });
    y -= hh + 10;
  };
  for (const l of lines) {
    draw(l, l === "Signing record" ? bold : font);
    if (clientSig && l.startsWith(`Signed electronically by ${o.signerName} on `)) drawSig(clientSig);
    if (providerSig && l.startsWith(`Signed electronically by ${countersigner} for Book Clarity, LLC on `)) drawSig(providerSig);
  }
  const safe = o.client.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return { bytes: await doc.save(), filename: `Book-Clarity-agreement-${safe}-${o.countersignedAt.toISOString().slice(0, 10)}.pdf`, lines };
}

/** Owners: every agreement a client has signed, newest first. */
export async function signedContracts() {
  await requirePermission("ace.manage");
  const rows = await db.onboarding.findMany({
    where: { signedAt: { not: null } },
    include: { client: { include: { package: true } } },
    orderBy: { signedAt: "desc" },
  });
  return rows.map((o) => ({
    onboardingId: o.id,
    clientId: o.clientId,
    clientName: o.client.name,
    packageName: o.client.package?.name ?? null,
    signerName: o.signerName,
    signedAt: o.signedAt!,
    countersignedAt: o.countersignedAt,
    status: o.countersignedAt ? "Fully signed" : "Waiting for countersignature",
  }));
}
