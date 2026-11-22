"use client";

import { useActionState } from "react";
import { linkPackageAction, revertPriceAction, setMainAction, type PriceFormState } from "./price-actions";

export function LinkPackageForm(p: { clientId: string; subscriptionId: string; packageId: string | null; packages: { id: string; label: string }[] }) {
  const [s, action, pending] = useActionState<PriceFormState, FormData>(linkPackageAction, {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="clientId" value={p.clientId} />
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      <label>
        Package
        <select name="packageId" defaultValue={p.packageId ?? ""}>
          <option value="">Not linked</option>
          {p.packages.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </label>
      <button disabled={pending}>Save package</button>
      {s.ok && <p className="form-ok">Saved.</p>}
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}

export function RevertPriceButton(p: { clientId: string; subscriptionId: string; confirmText: string }) {
  const [s, action, pending] = useActionState<PriceFormState, FormData>(revertPriceAction, {});
  if (s.ok) {
    return (
      <>
        <p className="form-ok">Back on the original price from the next bill.</p>
        {s.note && <p className="muted">{s.note}</p>}
      </>
    );
  }
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm(p.confirmText)) e.preventDefault(); }}>
      <input type="hidden" name="clientId" value={p.clientId} />
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      <button disabled={pending}>Revert to original price</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}

export function MakeMainButton(p: { clientId: string; subscriptionId: string }) {
  const [s, action, pending] = useActionState<PriceFormState, FormData>(setMainAction, {});
  if (s.ok) return <p className="form-ok">This is now the client's main package.</p>;
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm("Make this the client's main package? Their status, package and \"months already earned\" follow the main package; other packages keep their own commission windows.")) e.preventDefault(); }}>
      <input type="hidden" name="clientId" value={p.clientId} />
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      <button className="secondary" disabled={pending}>Make this the main package</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
