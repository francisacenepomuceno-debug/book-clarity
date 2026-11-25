"use client";

import { useEffect, useRef, useState } from "react";

/** Filters the dashboard's client tables as you type (name, email, package). Rows carry a data-search attribute. */
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
    // Grouped tables (one per status): hide a group with no matches and show "x of y" in its heading.
    document.querySelectorAll<HTMLElement>(`#${tableId} [data-group]`).forEach((g) => {
      const visible = g.querySelectorAll("tbody tr[data-search]:not([hidden])").length;
      g.hidden = words.length > 0 && visible === 0;
      const count = g.querySelector<HTMLElement>(".group-count");
      if (count) {
        const total = Number(count.dataset.total ?? 0);
        count.textContent = words.length ? `${visible} of ${total}` : `${total} client${total === 1 ? "" : "s"}`;
      }
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
