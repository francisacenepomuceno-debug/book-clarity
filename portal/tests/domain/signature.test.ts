import { describe, expect, it } from "vitest";
import { MAX_SIGNATURE_BYTES, parseSignatureImage } from "@/domain/signature";
import { blankPng, scribblePng } from "../helpers/png";

describe("parseSignatureImage", () => {
  it("accepts a drawn PNG signature", () => {
    const img = scribblePng();
    expect(parseSignatureImage(img)).toEqual({ ok: true, image: img });
  });
  it("asks to draw when the pad is empty or untouched", () => {
    expect(parseSignatureImage("")).toMatchObject({ ok: false, error: "Please draw your signature in the box." });
    expect(parseSignatureImage(blankPng())).toMatchObject({ ok: false, error: "Please draw your signature in the box." });
  });
  it("refuses anything that isn't a PNG data URL", () => {
    expect(parseSignatureImage("data:image/svg+xml;base64,PHN2Zy8+").ok).toBe(false);
    expect(parseSignatureImage(`data:image/png;base64,${Buffer.from("GIF89a" + "x".repeat(2000)).toString("base64")}`).ok).toBe(false);
    expect(parseSignatureImage("data:image/png;base64,not base64!").ok).toBe(false);
  });
  it("refuses an oversized image", () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_SIGNATURE_BYTES)]);
    expect(parseSignatureImage(`data:image/png;base64,${big.toString("base64")}`)).toMatchObject({ ok: false });
  });
});
