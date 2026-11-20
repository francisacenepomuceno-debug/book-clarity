"use client";

import { useActionState } from "react";
import { setupAction, type CreateUserState } from "@/users/actions";
import { CredentialsCard } from "@/users/ui/CredentialsCard";

export function SetupForm({ loginUrl }: { loginUrl: string }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(setupAction, {});
  if (state.created) {
    return (
      <>
        <CredentialsCard c={state.created} loginUrl={loginUrl} />
        <p className="muted">Next: add the key to your authenticator app, then <a href="/login">sign in</a>. You can now remove SETUP_TOKEN in Vercel.</p>
      </>
    );
  }
  return (
    <form action={action}>
      <label>Setup code (SETUP_TOKEN from Vercel)<input name="token" type="password" required /></label>
      <label>Your email<input name="email" type="email" required /></label>
      <label>Your name<input name="name" required /></label>
      {state.error && <p className="form-error">{state.error}</p>}
      <button disabled={pending}>{pending ? "Creating…" : "Create Super Admin"}</button>
    </form>
  );
}
