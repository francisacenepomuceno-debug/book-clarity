import { requirePermission } from "@/auth/permissions";
import { listAudit } from "@/audit/list";
import { PortalHeader } from "@/app/PortalHeader";

export const dynamic = "force-dynamic";
const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
const when = (d: Date) => d.toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "—" : s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string; actor?: string; entity?: string; cursor?: string }> }) {
  const viewer = await requirePermission("audit.view");
  const q = await searchParams;
  const data = await listAudit({ action: q.action || undefined, actorId: q.actor || undefined, entityId: q.entity?.trim() || undefined, cursor: q.cursor });
  const keep = new URLSearchParams(Object.entries({ action: q.action ?? "", actor: q.actor ?? "", entity: q.entity ?? "" }).filter(([, v]) => v));
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← Dashboard</a></p>
        <h2>Audit log</h2>
        <section className="panel pad">
          <form className="row-form" method="get">
            <select name="action" defaultValue={q.action ?? ""}>
              <option value="">All actions</option>
              {data.actions.map((a) => <option key={a}>{a}</option>)}
            </select>
            <select name="actor" defaultValue={q.actor ?? ""}>
              <option value="">Everyone</option>
              <option value="system">System (automatic)</option>
              {data.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <input name="entity" defaultValue={q.entity ?? ""} placeholder="Client or record id" />
            <button>Filter</button>
            {keep.size > 0 && <a href="/audit">Clear</a>}
          </form>
        </section>
        <section className="panel">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Changes</th></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan={5} className="muted">No entries.</td></tr>}
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                  <td>{r.actorName}</td>
                  <td><code>{r.action}</code></td>
                  <td>{r.entity} <a href={`/audit?entity=${encodeURIComponent(r.entityId)}`} className="muted">{r.entityId.slice(0, 12)}</a></td>
                  <td>
                    {r.changed.length === 0 ? <span className="muted">—</span> : (
                      <details>
                        <summary>{r.changed.join(", ")}</summary>
                        <ul className="plain">
                          {r.changed.map((k) => (
                            <li key={k}><strong>{k}</strong>: {short((r.before as Record<string, unknown> | null)?.[k])} → {short((r.after as Record<string, unknown> | null)?.[k])}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {data.next && <p><a href={`/audit?${new URLSearchParams([...keep, ["cursor", data.next]])}`}>Older entries →</a></p>}
      </main>
    </>
  );
}
