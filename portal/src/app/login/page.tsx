"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "@/auth/actions";
import { PasswordInput } from "@/app/PasswordInput";

export default function LoginPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <main className="auth">
      <form action={action} className="card">
        <h1>Book Clarity Portal</h1>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required defaultValue={state.email} key={state.email} />
        </label>
        <label>
          Password
          <PasswordInput name="password" autoComplete="current-password" required />
        </label>
        {state.error && <p className="form-error">{state.error}</p>}
        <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
