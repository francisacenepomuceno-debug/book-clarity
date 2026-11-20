"use client";

import { useActionState } from "react";
import type { OnboardingSettings } from "@/settings/onboarding";
import { saveOnboardingSettingsAction, type SettingsResult } from "./actions";

export function OnboardingSettingsForm(p: { settings: OnboardingSettings; owners: { id: string; name: string }[] }) {
  const [s, action, pending] = useActionState<SettingsResult, FormData>(saveOnboardingSettingsAction, {});
  return (
    <form action={action} className="stack-form" style={{ gap: 14 }}>
      <label>Countersigner (receives each signed agreement to countersign)
        <select name="countersignerUserId" defaultValue={p.settings.countersignerUserId}>
          <option value="">First Owner</option>
          {p.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label>Onboarding call booking link (GHL calendar)
        <input name="calendarUrl" defaultValue={p.settings.calendarUrl} placeholder="https://…" />
      </label>
      <label>Suspend unpaid clients after (days since the first failed payment)
        <input name="suspendAfterDays" type="number" min={7} max={120} defaultValue={p.settings.suspendAfterDays} />
      </label>
      <label>Questionnaire. One question per line: <code>Question | type | required | if: Earlier question = Answer</code>. Types: text (default), <code>long</code>, <code>number</code>, <code>yesno</code> (answers YES / NO), <code>choice: A; B; C</code>. A line starting <code>## </code> is a section heading and <code>&gt; </code> a note. The <code>if:</code> part shows a follow-up only for that answer and must match the earlier question exactly.
        <textarea name="intakeQuestions" rows={16} defaultValue={p.settings.intakeQuestions} style={{ fontFamily: "monospace" }} />
      </label>
      <button disabled={pending}>Save</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && <p className="form-ok">Saved.</p>}
    </form>
  );
}
