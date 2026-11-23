import type { Role } from "@prisma/client";
import { logoutAction } from "@/auth/actions";
import { can } from "@/auth/permissions";
import { outsideDueCount } from "@/billing/outsideDue";
import { SideNavLinks } from "@/app/SideNavLinks";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

/** Staff navigation: a sidebar down the left (a "Menu" button on phones). */
export async function PortalHeader(p: { viewerName: string; role: Role; livemode?: boolean; fetchedAt?: Date; refreshHref?: string }) {
  // In-app reminder: outside-Stripe bills due within 7 days or overdue.
  const outsideDue = can(p.role, "discounts.apply") ? await outsideDueCount() : 0;
  const links = [
    { href: "/", label: "Clients" },
    can(p.role, "onboarding.view") && { href: "/onboarding", label: "Onboarding" },
    can(p.role, "payments.view") && { href: "/payments", label: "Payments" },
    can(p.role, "discounts.apply") && { href: "/payments/outside", label: "Outside payments", badge: outsideDue },
    can(p.role, "reports.view") && { href: "/reports", label: "Reports" },
    can(p.role, "commissions.view") && { href: "/commissions", label: "Commissions" },
    can(p.role, "ace.manage") && { href: "/ace", label: "ACE" },
    can(p.role, "ace.manage") && { href: "/settings/packages", label: "Packages" },
    can(p.role, "audit.view") && { href: "/audit", label: "Audit" },
    can(p.role, "users.manage") && { href: "/settings/users", label: "Users" },
    can(p.role, "settings.manage") && { href: "/settings/launch", label: "Launch" },
  ].filter(Boolean) as { href: string; label: string; badge?: number }[];
  return (
    <header className="sidebar">
      <h1 className="brand">
        <a href="/" aria-label="Book Clarity client portal: home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/book-clarity-logo.png" alt="Book Clarity" width={148} height={40} />
          <span className="brand-sub">Client Portal</span>
        </a>
      </h1>
      {/* Phones: the Menu button opens the panel (no script needed). */}
      <input type="checkbox" id="side-toggle" className="side-toggle" aria-label="Open the menu" />
      <label htmlFor="side-toggle" className="side-toggle-btn">Menu{outsideDue ? <span className="side-badge">{outsideDue}</span> : null}</label>
      <div className="side-panel">
        <nav aria-label="Main">
          <SideNavLinks links={links} />
        </nav>
        <div className="side-foot">
          {p.fetchedAt && (
            <p className="side-data">
              {p.livemode ? "Live Stripe data" : "Stripe TEST data"}
              <br />
              updated {p.fetchedAt.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}
              {p.refreshHref && <> · <a href={p.refreshHref}>Refresh</a></>}
            </p>
          )}
          <p className="side-user">{p.viewerName}</p>
          <form action={logoutAction}>
            <button className="linklike">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
