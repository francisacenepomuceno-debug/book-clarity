"use client";

import { useActionState } from "react";
import { callBookedAction, detailsAction, intakeAction, packageAction, signAction, type StepResult } from "./actions";

const Err = ({ s }: { s: StepResult }) => (s.error ? <p className="form-error">{s.error}</p> : null);

export function PackageStep(p: { token: string; packages: { id: string; name: string; monthly: string; fee: string }[] }) {
  const [s, action, pending] = useActionState(packageAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="token" value={p.token} />
      {p.packages.map((k) => (
        <label key={k.id} className="paybtn" style={{ cursor: "pointer" }}>
          <span><input type="radio" name="packageId" value={k.id} required /> <strong>{k.name}</strong></span>
          <span>{k.monthly}/month · onboarding fee {k.fee}</span>
        </label>
      ))}
      <button disabled={pending}>Continue</button>
      <Err s={s} />
    </form>
  );
}

const DETAIL_FIELDS: [string, string, boolean][] = [
  ["business", "Business name (as it should appear on your agreement)", true],
  ["firstName", "Your first name", true],
  ["signerName", "Your full name (the person signing)", true],
  ["phone", "Phone number", true],
  ["address1", "Address line 1", true],
  ["address2", "Address line 2", false],
  ["city", "City", true],
  ["state", "State", true],
  ["zip", "Zip / postal code", true],
];

export function DetailsStep(p: { token: string; initial: Record<string, string> }) {
  const [s, action, pending] = useActionState(detailsAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="token" value={p.token} />
      {DETAIL_FIELDS.map(([k, label, req]) => (
        <label key={k}>{label}<input name={k} defaultValue={p.initial[k] ?? ""} required={req} /></label>
      ))}
      <button disabled={pending}>Continue to your agreement</button>
      <Err s={s} />
    </form>
  );
}

export function SignStep(p: { token: string; signerName: string; quickbooksOptions: string[] }) {
  const [s, action, pending] = useActionState(signAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="token" value={p.token} />
      <label className="check"><input type="checkbox" name="confirmDetails" /> I can confirm the details above are correct.</label>
      <label className="check"><input type="checkbox" name="agreeAutopay" /> I agree to the terms above, including automatic monthly payments.</label>
      {p.quickbooksOptions.length > 0 && (
        <fieldset>
          <legend>QuickBooks</legend>
          {p.quickbooksOptions.map((o, i) => (
            <label key={i} className="check"><input type="radio" name="quickbooks" value={i} required /> {o}</label>
          ))}
        </fieldset>
      )}
      <label>Type your full name to sign ({p.signerName})<input name="signerName" required autoComplete="off" /></label>
      <p className="muted">By typing your name and clicking Sign, you are signing this agreement electronically. We record the date, time and your IP address.</p>
      <button disabled={pending}>Sign agreement</button>
      <Err s={s} />
    </form>
  );
}

export function IntakeStep(p: { token: string; questions: { label: string; kind: string; options: string[] }[] }) {
  const [s, action, pending] = useActionState(intakeAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="token" value={p.token} />
      {p.questions.map((q, i) => (
        <label key={i}>
          {q.label}
          {q.kind === "long" ? (
            <textarea name={`q${i}`} rows={3} />
          ) : q.kind === "yesno" ? (
            <select name={`q${i}`} defaultValue=""><option value="">—</option><option>Yes</option><option>No</option></select>
          ) : q.kind === "choice" ? (
            <select name={`q${i}`} defaultValue=""><option value="">—</option>{q.options.map((o) => <option key={o}>{o}</option>)}</select>
          ) : (
            <input name={`q${i}`} />
          )}
        </label>
      ))}
      <button disabled={pending}>Continue</button>
      <Err s={s} />
    </form>
  );
}

export function CallStep(p: { token: string; calendarUrl: string }) {
  const [s, action, pending] = useActionState(callBookedAction, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="token" value={p.token} />
      {p.calendarUrl ? (
        <p><a className="paybtn" href={p.calendarUrl} target="_blank" rel="noreferrer"><strong>Book your onboarding call</strong><span>Opens our calendar in a new tab</span></a></p>
      ) : (
        <p>Our team will reach out to schedule your onboarding call with Alex, Rochelle or Henry.</p>
      )}
      <button disabled={pending}>{p.calendarUrl ? "I've booked my call" : "Finish"}</button>
      <Err s={s} />
    </form>
  );
}
