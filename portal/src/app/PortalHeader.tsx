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
    can(p.role, "users.manage") && { href: "/settings/users", label: "Users" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <header>
      <h1>
        <a href="/" style={{ color: "inherit", textDecoration: "none" }}>Book Clarity · Client Dashboard</a>
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
