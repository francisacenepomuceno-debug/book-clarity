"use client";

import { useActionState } from "react";
import { renameClientAction, separateCompanyAction, type CompanyFormState } from "./company-actions";

export function RenameCompanyForm(p: { clientId: string; subscriptionId: string; name: string; contact: string }) {
  const [s, action, pending] = useActionState<CompanyFormState, FormData>(renameClientAction, {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="clientId" value={p.clientId} />
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      <label className="grow">Company name <span className="muted" style={{ fontWeight: 400 }}>(contact: {p.contact}, from Stripe)</span><input name="name" defaultValue={p.name} placeholder="e.g. Hispanic Plug" /></label>
      <button className="secondary" disabled={pending}>Save company name</button>
      {s.ok && <p className="form-ok">Saved.</p>}
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}

export function SeparateCompanyForm(p: { subscriptionId: string; packageLabel: string }) {
  const [s, action, pending] = useActionState<CompanyFormState, FormData>(separateCompanyAction, {});
  if (s.ok) return <p className="form-ok">This package is now its own company. Refresh to see it.</p>;
  return (
    <form
      action={action}
      className="inline-form"
      onSubmit={(e) => {
        if (!window.confirm(`Make "${p.packageLabel}" a separate company? It gets its own client record, main package and commission window; its invoices move with it. Stripe isn't changed.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      <label className="grow">This package is for a different company: its name<input name="name" placeholder="e.g. Mundo Media" required /></label>
      <button disabled={pending}>Separate company</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
