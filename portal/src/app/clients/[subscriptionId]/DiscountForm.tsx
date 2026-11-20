"use client";

import { useActionState } from "react";
import { applyDiscountAction, type DiscountFormState } from "./discount-action";

export function DiscountForm({ subscriptionId }: { subscriptionId: string }) {
  const [state, action, pending] = useActionState<DiscountFormState, FormData>(applyDiscountAction, {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <label>
        Type
        <select name="kind" defaultValue="PERCENT">
          <option value="PERCENT">Percent off</option>
          <option value="AMOUNT">Dollar amount off</option>
        </select>
      </label>
      <label>
        Value
        <input name="value" type="number" min="0.01" step="0.01" required placeholder="20" />
      </label>
      <label>
        Months
        <input name="months" type="number" min="1" max="36" step="1" required placeholder="3" />
      </label>
      <label className="grow">
        Reason (required)
        <input name="reason" required placeholder="e.g. Approved by Jose for referral" />
      </label>
      <button disabled={pending}>{pending ? "Applying…" : "Apply discount"}</button>
      {state.error && <p className="form-error">{state.error}</p>}
      {state.ok && <p className="form-ok">Discount applied. It shows on the next invoice.</p>}
    </form>
  );
}
