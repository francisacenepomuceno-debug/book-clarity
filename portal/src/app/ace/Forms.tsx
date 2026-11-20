"use client";

import { useActionState, useState } from "react";
import {
  assignSlotAction,
  continueAction,
  createBatchAction,
  endAction,
  recordPaymentAction,
  resendInvoiceAction,
  cardPayLinkAction,
  setAceContactAction,
  savePackageAction,
  setAceCustomerAction,
  type AceFormResult,
} from "./actions";

type Pkg = { id: string; name: string; isCustom: boolean };
const Msg = ({ s, ok }: { s: AceFormResult; ok?: string }) => (
  <>
    {s.error && <p className="form-error">{s.error}</p>}
    {s.ok && ok && <p className="form-ok">{ok}</p>}
  </>
);

export function PackageForm(p: { pkg?: { id: string; name: string; monthly: string; onboarding: string; isCustom: boolean; stripePriceId: string } }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(savePackageAction, {});
  const k = p.pkg;
  return (
    <form action={action} className="inline-form">
      {k && <input type="hidden" name="id" value={k.id} />}
      <label>Name<input name="name" defaultValue={k?.name} required /></label>
      <label>Monthly price ($)<input name="monthly" type="number" step="0.01" min="0" defaultValue={k?.monthly} required /></label>
      <label>Onboarding fee ($)<input name="onboarding" type="number" step="0.01" min="0" defaultValue={k?.onboarding} required /></label>
      <label>Stripe price ID<input name="stripePriceId" defaultValue={k?.stripePriceId} placeholder="price_…" /></label>
      <label className="check"><input type="checkbox" name="isCustom" defaultChecked={k?.isCustom} /> Custom (price set per client)</label>
      <button disabled={pending}>{k ? "Save" : "Add package"}</button>
      <Msg s={s} ok="Saved." />
    </form>
  );
}

export function AceCustomerForm({ current }: { current: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(setAceCustomerAction, {});
  return (
    <form action={action} className="inline-form">
      <label className="grow">ACE's Stripe customer ID<input name="customerId" defaultValue={current} placeholder="cus_…" required /></label>
      <button disabled={pending}>Save</button>
      <Msg s={s} ok="Saved. New batches will be invoiced to this customer." />
    </form>
  );
}

export function NewBatchForm({ packages, today }: { packages: Pkg[]; today: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(createBatchAction, {});
  const [paid, setPaid] = useState(false);
  return (
    <form action={action} className="stack-form">
      <div className="inline-form">
        <label>Purchase date<input name="purchasedOn" type="date" defaultValue={today} required /></label>
        <label className="grow">Note (optional)<input name="note" placeholder="e.g. November cohort" /></label>
      </div>
      {[0, 1, 2, 3].map((n) => (
        <div className="inline-form" key={n}>
          <label>
            Package {n + 1}
            <select name={`pkg${n}`} defaultValue="" required={n === 0}>
              <option value="">{n === 0 ? "Choose…" : "— none —"}</option>
              {packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>Slots<input name={`qty${n}`} type="number" min="1" step="1" /></label>
          <label>ACE price per slot ($)<input name={`price${n}`} type="number" min="0.01" step="0.01" /></label>
        </div>
      ))}
      <label className="check"><input type="checkbox" name="alreadyPaid" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Already paid outside the portal (no Stripe invoice)</label>
      {paid && (
        <div className="inline-form">
          <label>Paid on<input name="paidOn" type="date" defaultValue={today} required /></label>
          <label>
            Method
            <select name="method" defaultValue="check">
              <option value="check">Check</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="ach">ACH</option>
              <option value="card">Card</option>
            </select>
          </label>
          <label className="grow">Reference<input name="reference" placeholder="Check # or transfer reference" /></label>
        </div>
      )}
      <div><button disabled={pending}>{pending ? "Saving…" : paid ? "Record batch" : "Create batch and invoice ACE"}</button></div>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && s.batchId && <p className="form-ok">Batch saved. <a href={`/ace/${s.batchId}`}>Open it to assign clients</a>.</p>}
    </form>
  );
}

export function RecordPaymentForm({ batchId, today }: { batchId: string; today: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(recordPaymentAction, {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="batchId" value={batchId} />
      <label>Paid on<input name="paidOn" type="date" defaultValue={today} required /></label>
      <label>
        Method
        <select name="method" defaultValue="bank_transfer">
          <option value="bank_transfer">Bank transfer</option>
          <option value="check">Check</option>
          <option value="ach">ACH</option>
        </select>
      </label>
      <label className="grow">Reference<input name="reference" placeholder="Check # or transfer reference" /></label>
      <button disabled={pending}>Record payment received</button>
      <Msg s={s} ok="Payment recorded." />
    </form>
  );
}

export function AssignSlotForm(p: { batchId: string; packages: (Pkg & { open: number })[]; clients: { id: string; name: string }[]; today: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(assignSlotAction, {});
  const [pkg, setPkg] = useState(p.packages.find((x) => x.open > 0)?.id ?? "");
  const isCustom = p.packages.find((x) => x.id === pkg)?.isCustom;
  return (
    <form action={action} className="stack-form">
      <input type="hidden" name="batchId" value={p.batchId} />
      <div className="inline-form">
        <label>
          Existing client
          <select name="clientId" defaultValue="">
            <option value="">— new client —</option>
            {p.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>or new client name<input name="newName" placeholder="Business name" /></label>
        <label>Email<input name="newEmail" type="email" placeholder="owner@business.com" /></label>
      </div>
      <div className="inline-form">
        <label>
          Package
          <select name="packageId" value={pkg} onChange={(e) => setPkg(e.target.value)} required>
            {p.packages.map((x) => <option key={x.id} value={x.id} disabled={x.open === 0}>{x.name} ({x.open} open)</option>)}
          </select>
        </label>
        <label>Onboarding (start) date<input name="startOn" type="date" defaultValue={p.today} required /></label>
        <label className="check"><input type="checkbox" name="confirmSubscribed" /> Client is on autopay and this is a past assignment</label>
        {isCustom && <label>Custom monthly price ($)<input name="customMonthly" type="number" min="0.01" step="0.01" required /></label>}
        <button disabled={pending}>Assign to slot</button>
      </div>
      <Msg s={s} ok="Assigned. The client is Prepaid by ACE for 6 months." />
    </form>
  );
}

export function ContinuationButtons({ clientId, decision }: { clientId: string; decision?: string | null }) {
  const [c, cont, p1] = useActionState<AceFormResult, FormData>(continueAction, {});
  const [e, end, p2] = useActionState<AceFormResult, FormData>(endAction, {});
  return (
    <div className="row-form">
      {decision !== "CONTINUING" && (
        <form action={cont}><input type="hidden" name="clientId" value={clientId} /><button disabled={p1}>Mark continuing</button></form>
      )}
      {decision === "CONTINUING" && (
        <form action={cont}><input type="hidden" name="clientId" value={clientId} /><button className="secondary" disabled={p1}>Get their link</button></form>
      )}
      {decision !== "ENDING" && (
        <form action={end}><input type="hidden" name="clientId" value={clientId} /><button className="secondary" disabled={p2}>Confirm end of service</button></form>
      )}
      {c.setupUrl && (
        <div className="copybox">
          Send this link to the client (they choose Yes or No; Yes sets up autopay): <input readOnly value={c.setupUrl} onFocus={(ev) => ev.currentTarget.select()} />
        </div>
      )}
      {(c.error || e.error) && <span className="form-error">{c.error || e.error}</span>}
      {e.ok && <span className="form-ok">Ends when the prepaid period ends. You can still mark them continuing until then.</span>}
    </div>
  );
}

export function ResendInvoiceForm({ batchId }: { batchId: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(resendInvoiceAction, {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="batchId" value={batchId} />
      <button disabled={pending}>Send invoice again</button>
      <Msg s={s} ok="ACE's invoice was sent." />
    </form>
  );
}

export function CardPayLinkForm({ batchId }: { batchId: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(cardPayLinkAction, {});
  return (
    <form action={action} className="row-form">
      <input type="hidden" name="batchId" value={batchId} />
      <button className="secondary" disabled={pending}>Get payment link</button>
      {s.setupUrl && (
        <div className="copybox">
          Send this to ACE. They choose bank (ACH, no fee) or card (credit cards add 3%): <input readOnly value={s.setupUrl} onFocus={(ev) => ev.currentTarget.select()} />
        </div>
      )}
      {s.error && <span className="form-error">{s.error}</span>}
    </form>
  );
}

export function AceContactForm({ current }: { current: string }) {
  const [s, action, pending] = useActionState<AceFormResult, FormData>(setAceContactAction, {});
  return (
    <form action={action} className="inline-form">
      <label className="grow">ACE billing contact email<input name="email" type="email" defaultValue={current} placeholder="billing@ace…" required /></label>
      <button disabled={pending}>Save</button>
      <Msg s={s} ok="Saved. Unpaid-batch reminders go to this address." />
    </form>
  );
}
