/** A drawn signature as sent by the signature pad: a PNG data URL. */
const PREFIX = "data:image/png;base64,";
/** Generous for a line drawing; keeps rows small. */
export const MAX_SIGNATURE_BYTES = 200_000;
/** Below this it's a dot or a stray tap, not a signature (the pad crops to the ink). */
const MIN_SIGNATURE_BYTES = 400;

/** Pure: checks a drawn signature. Returns the data URL to store, or an error for the signer. */
export function parseSignatureImage(raw: string | null | undefined): { ok: true; image: string } | { ok: false; error: string } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: false, error: "Please draw your signature in the box." };
  if (!v.startsWith(PREFIX)) return { ok: false, error: "That signature couldn't be read. Please clear it and draw it again." };
  const b64 = v.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "That signature couldn't be read. Please clear it and draw it again." };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, error: "That signature is too large. Please clear it and draw it again." };
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!png) return { ok: false, error: "That signature couldn't be read. Please clear it and draw it again." };
  if (bytes.length < MIN_SIGNATURE_BYTES) return { ok: false, error: "Please draw your signature in the box." };
  return { ok: true, image: v };
}

export const signatureBytes = (image: string): Uint8Array => Buffer.from(image.slice(PREFIX.length), "base64");
