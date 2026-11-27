import { requirePermission } from "@/auth/permissions";
import { messageLog } from "@/notify/log";
import { noticesOn } from "@/settings/launch";
import { ghlConfigured } from "@/ghl/client";
import { PortalHeader } from "@/app/PortalHeader";

export const dynamic = "force-dynamic";
const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const STATUSES = ["SENT", "SKIPPED", "FAILED"] as const;
const LABEL: Record<string, string> = { SENT: "Sent", SKIPPED: "Not sent", FAILED: "Failed", PENDING: "In progress" };
const BADGE: Record<string, string> = { SENT: "CURRENT", SKIPPED: "UNPAID", FAILED: "PAST_DUE", PENDING: "UNPAID" };
const when = (d: Date) => d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const viewer = await requirePermission("audit.view");
  const q = await searchParams;
  const status = STATUSES.find((s) => s === q.status);
  const [{ rows, counts, total }, on] = await Promise.all([messageLog({ status }), noticesOn()]);
  const connected = ghlConfigured();

  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Messages</h2>
        <p className="muted">Every email and text the portal tried to send to clients and staff, and why any weren't sent.</p>
        {(!on || !connected) && (
          <section className="panel pad">
            <strong>Messages are not going out yet.</strong>
            <ul>
              {!connected && <li>GHL isn't connected. Add <code>GHL_API_TOKEN</code> and <code>GHL_LOCATION_ID</code> in Vercel, then redeploy.</li>}
              {!on && <li>Client notices are off. Turn them on from the <a href="/settings/launch">Launch</a> page (Super Admin).</li>}
            </ul>
          </section>
        )}
        <section className="kpis">
          <a href="/messages" className={`kpi ${!status ? "active" : ""}`}><div className="label">All</div><div className="value">{total}</div></a>
          {STATUSES.map((s) => (
            <a key={s} href={`/messages?status=${s}`} className={`kpi ${status === s ? "active" : ""}`}>
              <div className="label">{LABEL[s]}</div>
              <div className="value">{counts[s] ?? 0}</div>
            </a>
          ))}
        </section>
        <section className="panel">
          <table className="wrap">
            <thead><tr><th>When</th><th>Message</th><th>Client</th><th>To</th><th>Status</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="muted">No messages yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.at)}</td>
                  <td>{r.kindLabel}</td>
                  <td>{r.clientId ? <a href={`/clients/${r.clientId}`}>{r.clientName ?? "Client"}</a> : "—"}</td>
                  <td>{r.to ?? "—"}{r.status === "SENT" && r.channels ? <div className="muted">{r.channels.replace(",", " + ")}</div> : null}</td>
                  <td>
                    <span className={`badge s-${BADGE[r.status] ?? "UNPAID"}`}>{LABEL[r.status] ?? r.status}</span>
                    {r.why && <div className="muted">{r.why}{r.status === "FAILED" && r.attempts ? ` (${r.attempts} attempt${r.attempts === 1 ? "" : "s"})` : ""}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
