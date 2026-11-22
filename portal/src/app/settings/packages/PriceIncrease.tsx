"use client";

import { useActionState } from "react";
import { cancelPriceIncreaseAction, schedulePriceIncreaseAction, type PriceChangeFormState } from "./price-actions";

export function PriceIncreaseForm(p: { packageId: string; packageName: string; currentPrice: string; earliest: string; suggested: string }) {
  const [s, action, pending] = useActionState<PriceChangeFormState, FormData>(schedulePriceIncreaseAction, {});
  return (
    <form
      action={action}
      className="inline-form"
      onSubmit={(e) => {
        const f = new FormData(e.currentTarget);
        const msg = `Raise ${p.packageName} from ${p.currentPrice} to $${f.get("newMonthly")}/month starting ${f.get("startsOn")}?\n\nNew clients pay the new price from that date. Current clients on the full price move at their first bill on or after it, and are emailed 30 days before. Clients with a discount or custom price are not changed.`;
        if (!window.confirm(msg)) e.preventDefault();
      }}
    >
      <input type="hidden" name="packageId" value={p.packageId} />
      <label>New monthly price ($)<input name="newMonthly" type="number" step="0.01" min="1" required /></label>
      <label>Starts on<input name="startsOn" type="date" min={p.earliest} defaultValue={p.suggested} required /></label>
      <button disabled={pending}>Schedule price increase</button>
      {s.error && <p className="form-error">{s.error}</p>}
      {s.ok && <p className="form-ok">Scheduled.</p>}
    </form>
  );
}

export function CancelPriceIncrease({ priceChangeId }: { priceChangeId: string }) {
  const [s, action, pending] = useActionState<PriceChangeFormState, FormData>(cancelPriceIncreaseAction, {});
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm("Cancel this price increase? No client has been moved yet.")) e.preventDefault(); }}>
      <input type="hidden" name="priceChangeId" value={priceChangeId} />
      <button className="secondary" disabled={pending}>Cancel price increase</button>
      {s.error && <p className="form-error">{s.error}</p>}
    </form>
  );
}
