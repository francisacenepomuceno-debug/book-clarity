"use client";

import { useActionState } from "react";
import { cardFeeAction, checkAction, historyAction, noticesAction, type HistoryResult, type LaunchResult } from "./actions";

const Msg = ({ s }: { s: LaunchResult }) => (s.error ? <p className="form-error">{s.error}</p> : null);

export function CheckToggle(p: { k: string; done: boolean }) {
  const [s, action, pending] = useActionState<LaunchResult, FormData>(checkAction, {});
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="key" value={p.k} />
      <input type="hidden" name="done" value={p.done ? "0" : "1"} />
      <button className={p.done ? "secondary" : ""} disabled={pending}>{p.done ? "Undo" : "Mark done"}</button>
      <Msg s={s} />
    </form>
  );
}

export function NoticesSwitch(p: { on: boolean }) {
  const [s, action, pending] = useActionState<LaunchResult, FormData>(noticesAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="on" value={p.on ? "0" : "1"} />
      <button className={p.on ? "secondary" : ""} disabled={pending}>{p.on ? "Turn client notices off" : "Turn client notices on"}</button>
      <Msg s={s} />
    </form>
  );
}

export function CardFeeForm(p: { enabled: boolean; ratePercent: number; states: string }) {
  const [s, action, pending] = useActionState<LaunchResult, FormData>(cardFeeAction, {});
  return (
    <form action={action} className="inline-form">
      <label>Rate (%)<input name="rate" type="number" step="0.01" min="0" max="3" defaultValue={p.ratePercent} /></label>
      <label>States with no fee<input name="states" defaultValue={p.states} placeholder="e.g. CT, MA" /></label>
      <button name="enabled" value={p.enabled ? "1" : "0"} className="secondary" disabled={pending}>Save rate and states</button>
      <button name="enabled" value={p.enabled ? "0" : "1"} disabled={pending}>{p.enabled ? "Turn card fee off" : "Turn card fee on"}</button>
      <Msg s={s} />
      {s.ok && <p className="form-ok">Saved.</p>}
    </form>
  );
}

export function HistoryForm() {
  const [s, action, pending] = useActionState<HistoryResult, FormData>(historyAction, {});
  return (
    <form action={action} className="inline-form">
      <label>Copy invoices from<input name="since" type="date" defaultValue="2025-01-01" required /></label>
      <button disabled={pending}>{pending ? "Loading… (up to a few minutes)" : "Load invoice history"}</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && <p className="form-ok">{s.summary}</p>}
    </form>
  );
}
