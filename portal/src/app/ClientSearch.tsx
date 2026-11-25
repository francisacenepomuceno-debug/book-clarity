"use client";

import { useEffect, useRef, useState } from "react";

/** Filters the dashboard's client table as you type (name, email, package). Rows carry a data-search attribute. */
export function ClientSearch({ tableId }: { tableId: string }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const rows = document.querySelectorAll<HTMLTableRowElement>(`#${tableId} tbody tr[data-search]`);
    const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let n = 0;
    rows.forEach((tr) => {
      const hit = words.every((w) => (tr.dataset.search ?? "").includes(w));
      tr.hidden = !hit;
      if (hit) n++;
    });
    setShown(words.length ? n : null);
  }, [q, tableId]);

  // "/" jumps to the search box, as on most sites.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="client-search">
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
        placeholder="Search clients by name, email or package…  ( / )"
        aria-label="Search clients"
      />
      {shown !== null && <span className="muted">{shown === 0 ? "No clients match." : `${shown} match${shown === 1 ? "" : "es"}`}</span>}
    </div>
  );
}
