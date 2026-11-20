import { logoutAction } from "@/auth/actions";

const TZ = process.env.BUSINESS_TZ ?? "America/New_York";

export function PortalHeader(p: { viewerName: string; livemode?: boolean; fetchedAt?: Date; refreshHref?: string }) {
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
        {p.viewerName}{" "}
        <form action={logoutAction} style={{ display: "inline" }}>
          <button className="linklike">Sign out</button>
        </form>
      </small>
    </header>
  );
}
