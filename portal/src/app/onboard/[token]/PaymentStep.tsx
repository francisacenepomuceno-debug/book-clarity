import { onboardingPayOptions } from "@/onboarding/payment";
import { formatUsd } from "@/lib/money";
import { payAction } from "./actions";

/** Pay the onboarding fee: bank account (ACH, no fee) or card (3% added for credit cards). */
export async function PaymentStep({ token }: { token: string }) {
  const o = await onboardingPayOptions(token);
  if ("error" in o) return <p>{o.error}</p>;
  return (
    <>
      {o.declined && <p className="form-error">Your last payment didn't go through. Please try again, or use a different bank account or card.</p>}
      {o.feeCents === 0 ? (
        <p>
          Good news: your onboarding fee has been <strong>waived</strong>. Add the bank account or card for your monthly payments (autopay). Nothing
          is charged today; your first monthly payment is 14 days from now.
        </p>
      ) : (
        <p>
          Onboarding fee: <strong>{formatUsd(o.feeCents)}</strong>, charged now. Your monthly billing starts 14 days after this payment, on the same
          payment method (autopay). Choose how you'd like to pay:
        </p>
      )}
      <form action={payAction}>
        <input type="hidden" name="token" value={token} />
        <button className="paybtn" name="method" value="bank">
          <strong>Bank account (ACH)</strong>
          <span>{o.feeCents === 0 ? "No processing fee on monthly payments" : `${formatUsd(o.feeCents)} · no processing fee`}</span>
        </button>
        <button className="paybtn" name="method" value="card">
          <strong>Card</strong>
          <span>
            {o.feeCents === 0
              ? "Credit cards add a 3% processing fee to monthly payments; debit cards don't"
              : o.creditCardFeeCents > 0
                ? `${formatUsd(o.feeCents + o.creditCardFeeCents)} with a credit card (includes a 3% processing fee) · ${formatUsd(o.feeCents)} with a debit card`
                : formatUsd(o.feeCents)}
          </span>
        </button>
      </form>
      <p className="muted">Payments are processed securely by Stripe. Credit cards also carry the 3% fee on monthly payments; bank accounts and debit cards don't.</p>
    </>
  );
}
