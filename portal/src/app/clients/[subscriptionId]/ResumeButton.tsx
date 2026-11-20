"use client";

import { useActionState } from "react";
import { resumeClientAction, type ResumeResult } from "./suspensionActions";

export function ResumeButton({ clientId }: { clientId: string }) {
  const [s, action, pending] = useActionState<ResumeResult, FormData>(resumeClientAction, {});
  return (
    <form action={action} className="row-form">
      <input type="hidden" name="clientId" value={clientId} />
      <button disabled={pending}>Resume billing now</button>
      {s.error && <span className="form-error">{s.error}</span>}
    </form>
  );
}
