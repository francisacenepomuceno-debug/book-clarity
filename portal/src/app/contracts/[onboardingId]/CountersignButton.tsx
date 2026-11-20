"use client";

import { useActionState } from "react";
import { countersignAction, type CsResult } from "./actions";

export function CountersignButton({ onboardingId }: { onboardingId: string }) {
  const [s, action, pending] = useActionState<CsResult, FormData>(countersignAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="onboardingId" value={onboardingId} />
      <p>By clicking Countersign you sign this agreement electronically on behalf of Book Clarity, LLC.</p>
      <button disabled={pending}>Countersign</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
