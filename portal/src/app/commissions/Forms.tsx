"use client";

import { useActionState } from "react";
import { addExecutiveAction, markPaidAction, setCommissionAction, setPackageMonthsAction, type FormResult } from "./actions";

export function AddExecutiveForm() {
  const [s, action, pending] = useActionState<FormResult, FormData>(addExecutiveAction, {});
  return (
    <form action={action} className="inline-form">
      <label>Name<input name="name" required placeholder="e.g. Jose" /></label>
      <button disabled={pending}>Add executive</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}

export function MarkPaidForm({ executiveId, month, today }: { executiveId: string; month: string; today: string }) {
  const [s, action, pending] = useActionState<FormResult, FormData>(markPaidAction, {});
  return (
    <form action={action} className="row-form">
      <input type="hidden" name="executiveId" value={executiveId} />
      <input type="hidden" name="month" value={month} />
      <input type="date" name="paidOn" defaultValue={today} required aria-label="Paid on" />
      <button disabled={pending}>Mark paid</button>
      {s.error && <span className="form-error">{s.error}</span>}
    </form>
  );
}

export function CommissionForm(p: {
  subscriptionId: string;
  executives: { id: string; name: string }[];
  current: { executiveId: string; ratePercent: number }[];
  monthsBeforePortal: number;
  today: string;
}) {
  const [s, action, pending] = useActionState<FormResult, FormData>(setCommissionAction, {});
  const row = (i: 1 | 2) => (
    <>
      <label>
        Executive {i}
        <select name={`exec${i}`} defaultValue={p.current[i - 1]?.executiveId ?? ""} required={i === 1}>
          <option value="">{i === 1 ? "Choose…" : "— none —"}</option>
          {p.executives.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </label>
      <label>
        Rate %
        <input name={`rate${i}`} type="number" step="0.01" min="0" max="30" defaultValue={p.current[i - 1]?.ratePercent ?? (i === 1 ? 10 : "")} />
      </label>
    </>
  );
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="subscriptionId" value={p.subscriptionId} />
      {row(1)}
      {row(2)}
      <label>
        Effective from
        <input name="effectiveFrom" type="date" defaultValue={p.today} required />
      </label>
      <label>
        Paid months earned before the portal
        <input name="monthsBeforePortal" type="number" min="0" max="12" step="1" defaultValue={p.monthsBeforePortal} />
      </label>
      <button disabled={pending}>{pending ? "Saving…" : "Save commission"}</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && <p className="form-ok">Saved. Any commission now due has been added.</p>}
    </form>
  );
}

/** Paid months of an additional package that already earned commission before the portal. */
export function PackageMonthsForm(p: { subscriptionId: string; pageKey: string; months: number }) {
  const [s, action, pending] = useActionState<FormResult, FormData>(setPackageMonthsAction, {});
  return (
    <form action={action} className="row-form">
      <input type="hidden" name="packageSubscriptionId" value={p.subscriptionId} />
      <input type="hidden" name="pageKey" value={p.pageKey} />
      <label className="muted">Months earned before the portal <input type="number" name="months" min={0} max={12} step={1} defaultValue={p.months} style={{ width: 70 }} /></label>
      <button className="secondary" disabled={pending}>Save</button>
      {s.ok && <span className="form-ok">Saved.</span>}
      {s.error && <span className="form-error">{s.error}</span>}
    </form>
  );
}
