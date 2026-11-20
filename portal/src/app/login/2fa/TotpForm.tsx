"use client";

import { useActionState } from "react";
import { verifyTotpAction, type FormState } from "@/auth/actions";

export function TotpForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyTotpAction, {});
  return (
    <form action={action}>
      <label>
        Code
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      </label>
      {state.error && <p className="form-error">{state.error}</p>}
      <button disabled={pending}>{pending ? "Checking…" : "Verify"}</button>
    </form>
  );
}
