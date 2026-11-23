"use client";

import { usePathname } from "next/navigation";

/** The sidebar's links, with the current page highlighted. */
export function SideNavLinks({ links }: { links: { href: string; label: string; badge?: number }[] }) {
  const path = usePathname() ?? "/";
  // The most specific link that matches the current page (so /payments/outside doesn't also light up Payments).
  const active = links
    .filter((l) => (l.href === "/" ? path === "/" || path.startsWith("/clients") : path === l.href || path.startsWith(`${l.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <ul className="side-links">
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href} className={l.href === active ? "active" : undefined} aria-current={l.href === active ? "page" : undefined}>
            <span>{l.label}</span>
            {l.badge ? <span className="side-badge" aria-label={`${l.badge} due`}>{l.badge}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}
