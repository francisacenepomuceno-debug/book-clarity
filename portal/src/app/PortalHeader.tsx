import type { Role } from "@prisma/client";
import { logoutAction } from "@/auth/actions";
import { can } from "@/auth/permissions";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

export function PortalHeader(p: { viewerName: string; role: Role; livemode?: boolean; fetchedAt?: Date; refreshHref?: string }) {
  const links = [
    can(p.role, "onboarding.view") && { href: "/onboarding", label: "Onboarding" },
    can(p.role, "payments.view") && { href: "/payments", label: "Payments" },
    can(p.role, "reports.view") && { href: "/reports", label: "Reports" },
    can(p.role, "commissions.view") && { href: "/commissions", label: "Commissions" },
    can(p.role, "ace.manage") && { href: "/ace", label: "ACE" },
    can(p.role, "ace.manage") && { href: "/settings/packages", label: "Packages" },
    can(p.role, "audit.view") && { href: "/audit", label: "Audit" },
    can(p.role, "users.manage") && { href: "/settings/users", label: "Users" },
    can(p.role, "settings.manage") && { href: "/settings/launch", label: "Launch" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <header>
      <h1 className="brand">
        <a href="/" aria-label="Book Clarity client portal: home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/book-clarity-logo.png" alt="Book Clarity" width={148} height={40} />
          <span className="brand-sub">Client Portal</span>
        </a>
      </h1>
      <small>
        {p.fetchedAt && (
          <>
            {p.livemode ? "Live Stripe data" : "Stripe TEST data"} · updated {p.fetchedAt.toLocaleTimeString("en-US", { timeZone: TZ })}
            {p.refreshHref && (
              <>
                {" "}· <a href={p.refreshHref}>Refresh</a>
              </>
            )}{" "}
            ·{" "}
          </>
        )}
        {links.map((l) => (
          <span key={l.href}>
            <a href={l.href}>{l.label}</a> ·{" "}
          </span>
        ))}
        {p.viewerName}{" "}
        <form action={logoutAction} style={{ display: "inline" }}>
          <button className="linklike">Sign out</button>
        </form>
      </small>
    </header>
  );
}
