"use client";

import { useActionState } from "react";
import { startOnboardingAction, type StartFormResult } from "./actions";

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
          <label>Onboarding fee ($)<input name="onboardingFee" type="number" step="0.01" min="0" placeholder="Package default" /></label>
        </>
      )}
      <button disabled={pending}>Create and send link</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && s.url && <p className="form-ok">Sent. Their link: <code>{s.url}</code></p>}
    </form>
  );
}
