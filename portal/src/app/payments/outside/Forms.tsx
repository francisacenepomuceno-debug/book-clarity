"use client";

import { useActionState, useState } from "react";
import { markPaidOutsideAction, setPaysOutsideAction, type OutsideFormState } from "./actions";

export function MarkPaidOutsideForm(p: { invoiceId: string; method: string | null; methods: readonly string[]; today: string }) {
  const [s, action, pending] = useActionState<OutsideFormState, FormData>(markPaidOutsideAction, {});
  if (s.ok) return <span className="form-ok">Marked paid.</span>;
  return (
    <form action={action} className="row-form" onSubmit={(e) => { if (!window.confirm("Mark this bill as paid outside Stripe? Stripe will show it as paid (no charge is made).")) e.preventDefault(); }}>
      <input type="hidden" name="invoiceId" value={p.invoiceId} />
      <input type="date" name="paidOn" defaultValue={p.today} max={p.today} required aria-label="Paid on" />
      <select name="method" defaultValue={p.method ?? ""} required aria-label="Paid by">
        <option value="" disabled>Paid by…</option>
        {p.methods.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <input name="reference" placeholder="Reference (check #, Zelle ID…)" aria-label="Reference" />
      <button disabled={pending}>Mark paid</button>
      {s.error && <span className="form-error">{s.error}</span>}
    </form>
  );
}

export function PaysOutsideForm(p: { clientId: string; pageKey: string; on: boolean; method: string | null; methods: readonly string[] }) {
  const [s, action, pending] = useActionState<OutsideFormState, FormData>(setPaysOutsideAction, {});
  const [on, setOn] = useState(p.on);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="clientId" value={p.clientId} />
      <input type="hidden" name="pageKey" value={p.pageKey} />
      <label className="check"><input type="checkbox" name="on" checked={on} onChange={(e) => setOn(e.target.checked)} /> Pays outside Stripe</label>
      {on && (
        <label>
          How they pay
          <select name="method" defaultValue={p.method ?? ""} required>
            <option value="" disabled>Choose…</option>
            {p.methods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      <button disabled={pending}>Save</button>
      {s.ok && <p className="form-ok">Saved.</p>}
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
