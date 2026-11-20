"use client";

import { useActionState } from "react";
import { createUserAction, type CreateUserState } from "@/users/actions";
import { CredentialsCard } from "@/users/ui/CredentialsCard";

export function NewUserForm({ loginUrl }: { loginUrl: string }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {});
  return (
    <>
      <form action={action} className="inline-form">
        <label>Email<input name="email" type="email" required /></label>
        <label>Name<input name="name" required /></label>
        <label>
          Role
          <select name="role" defaultValue="ADMIN">
            <option value="ADMIN">Admin (clients, payments, onboarding, reviews)</option>
            <option value="OWNER">Owner (everything except users and settings)</option>
            <option value="SUPER_ADMIN">Super Admin (everything)</option>
          </select>
        </label>
        <button disabled={pending}>{pending ? "Adding…" : "Add user"}</button>
        {state.error && <p className="form-error">{state.error}</p>}
      </form>
      {state.created && <CredentialsCard c={state.created} loginUrl={loginUrl} />}
    </>
  );
}
