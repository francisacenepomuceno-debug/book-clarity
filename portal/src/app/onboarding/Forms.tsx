"use client";

import { useActionState } from "react";
import { startOnboardingAction, waiveFeeAction, type StartFormResult } from "./actions";

export function NewClientForm(p: { packages: { id: string; name: string; isCustom: boolean }[]; canSetPrices: boolean }) {
  const [s, action, pending] = useActionState<StartFormResult, FormData>(startOnboardingAction, {});
  return (
    <form action={action} className="inline-form">
      <label>Client / business name<input name="name" required /></label>
      <label>Email<input name="email" type="email" required /></label>
      <label>Phone<input name="phone" placeholder="optional" /></label>
      <label>Type
        <select name="type" defaultValue="DIRECT">
          <option value="DIRECT">Direct</option>
          <option value="ACE">ACE</option>
        </select>
      </label>
      <label>Package
        <select name="packageId" defaultValue="">
          <option value="">Let the client choose</option>
          {p.packages.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      </label>
      {p.canSetPrices && (
        <>
          <label>Custom monthly price ($)<input name="customMonthly" type="number" step="0.01" min="0" placeholder="Custom package only" /></label>
          <label>Onboarding fee ($)<input name="onboardingFee" type="number" step="0.01" min="0" placeholder="Package default (0 to waive)" /></label>
        </>
      )}
      <button disabled={pending}>Create and send link</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && s.url && <p className="form-ok">Sent. Their link: <code>{s.url}</code></p>}
    </form>
  );
}

export function WaiveFeeButton({ onboardingId }: { onboardingId: string }) {
  const [s, action, pending] = useActionState<StartFormResult, FormData>(waiveFeeAction, {});
  if (s.ok) return <span className="muted">Fee waived</span>;
  return (
    <form action={action} style={{ display: "inline" }} onSubmit={(e) => { if (!confirm("Waive this client's onboarding fee? They'll still add a payment method for monthly autopay.")) e.preventDefault(); }}>
      <input type="hidden" name="onboardingId" value={onboardingId} />
      <button className="secondary" disabled={pending} style={{ padding: "2px 8px" }}>Waive fee</button>
      {s.error && <span className="form-error"> {s.error}</span>}
    </form>
  );
}
