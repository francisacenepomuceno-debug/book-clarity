import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, non-expiring public links (e.g. a setup or payment link sent to a client or to ACE).
 * They're revoked by the state of the thing they point at, not by time. Rotating AUTH_SECRET revokes them all.
 */
const mac = (purpose: string, id: string) =>
  createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`${purpose}:${id}`).digest("base64url");

export function signLink(purpose: string, id: string): string {
  return `${id}.${mac(purpose, id)}`;
}

export function verifyLink(purpose: string, token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  const expected = Buffer.from(mac(purpose, id));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got) ? id : null;
}
