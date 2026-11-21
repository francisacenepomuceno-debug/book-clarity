"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Draw-your-signature box (finger, pen or mouse). The drawing is put in a hidden input as a PNG data URL
 * named `name`, so it posts with the surrounding form. Empty until the signer draws.
 */
export function SignaturePad({ name, label }: { name: string; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const c = canvas.current!;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const { width, height } = c.getBoundingClientRect();
    c.width = Math.round(width * ratio);
    c.height = Math.round(height * ratio);
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0e182c";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const ctx = canvas.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = "#0e182c";
    ctx.fill();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const p = point(e);
    const ctx = canvas.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setValue(trimmed(canvas.current!));
  };
  const clear = () => {
    const c = canvas.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setValue("");
  };

  return (
    <div className="sigpad">
      <span className="sigpad-label">{label}</span>
      <canvas
        ref={canvas}
        className="sigpad-canvas"
        aria-label={label}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
      />
      <div className="sigpad-bar">
        <span className="muted">{value ? "Signature captured." : "Sign inside the box with your finger, pen or mouse."}</span>
        <button type="button" className="secondary sigpad-clear" onClick={clear}>Clear</button>
      </div>
      <input type="hidden" name={name} value={value} />
    </div>
  );
}

/** The drawing cropped to its ink (plus a small margin), so the stored signature isn't mostly empty space. */
function trimmed(c: HTMLCanvasElement): string {
  const ctx = c.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return "";
  const pad = 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Lets the signer choose to draw or type; renders the matching fields. */
export function SignMethod({ children }: { children: (mode: "draw" | "type") => React.ReactNode }) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  return (
    <>
      <div className="tabs sign-tabs" role="radiogroup" aria-label="How to sign">
        <label className={mode === "draw" ? "active" : ""}><input type="radio" name="sigMode" value="draw" checked={mode === "draw"} onChange={() => setMode("draw")} /> Draw signature</label>
        <label className={mode === "type" ? "active" : ""}><input type="radio" name="sigMode" value="type" checked={mode === "type"} onChange={() => setMode("type")} /> Type name</label>
      </div>
      {children(mode)}
    </>
  );
}
