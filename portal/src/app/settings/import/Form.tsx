"use client";

import { useActionState } from "react";
import { importAction, type ImportState } from "./actions";

export function ImportForm() {
  const [s, action, pending] = useActionState<ImportState, FormData>(importAction, {});
  return (
    <>
      <form action={action} className="stack-form" style={{ gap: 10 }}>
        <input type="hidden" name="step" value="preview" />
        <label>CSV file <input type="file" name="file" accept=".csv,text/csv" /></label>
        <details><summary>…or paste the rows</summary><textarea name="csv" rows={8} style={{ width: "100%", fontFamily: "monospace" }} defaultValue={s.csv ?? ""} /></details>
        <label className="check"><input type="checkbox" name="create" defaultChecked={s.create} /> Create executives that aren't in the portal yet</label>
        <button disabled={pending}>Check the file</button>
      </form>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.applied !== undefined && (
        <p className="form-ok">Applied {s.applied} row{s.applied === 1 ? "" : "s"}.{s.failed?.length ? ` ${s.failed.length} couldn't be applied (below).` : ""}</p>
      )}
      {s.ready && s.applied === undefined && (
        <section className="panel pad">
          <h3>Ready to apply ({s.ready.length})</h3>
          {s.ready.length > 0 && (
            <table>
              <thead><tr><th>Line</th><th>Client</th><th>Type</th><th>Commission</th><th>Months already earned</th><th>ACE slot</th></tr></thead>
              <tbody>
                {s.ready.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td><td>{r.clientName}</td><td>{r.type ?? "unchanged"}</td>
                    <td>{r.shares.map((x) => `${x.executiveName} ${x.ratePercent}%`).join(" + ") || "unchanged"}{r.newExecutives.length ? ` (new: ${r.newExecutives.join(", ")})` : ""}</td>
                    <td>{r.monthsBeforePortal ?? "unchanged"}</td>
                    <td>{r.ace ? `from ${r.ace.startOn}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.ready.length > 0 && (
            <form action={action}>
              <input type="hidden" name="step" value="apply" />
              <input type="hidden" name="csv" value={s.csv} />
              {s.create && <input type="hidden" name="create" value="on" />}
              <button disabled={pending}>Apply {s.ready.length} row{s.ready.length === 1 ? "" : "s"}</button>
            </form>
          )}
        </section>
      )}
      {(s.problems?.length || s.failed?.length) ? (
        <section className="panel pad">
          <h3>Not applied ({(s.problems?.length ?? 0) + (s.failed?.length ?? 0)})</h3>
          <p className="muted">Fix these in the sheet and import again, or set them on each client's page. Clients without an owner are also listed under Commissions.</p>
          <table>
            <thead><tr><th>Line</th><th>Client</th><th>Problem</th></tr></thead>
            <tbody>{[...(s.problems ?? []), ...(s.failed ?? [])].map((p, i) => <tr key={i}><td>{p.line}</td><td>{p.client}</td><td>{p.error}</td></tr>)}</tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
