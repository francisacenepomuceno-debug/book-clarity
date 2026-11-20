import { acePayOptions } from "@/ace/cardPay";
import { formatUsd } from "@/lib/money";

export const dynamic = "force-dynamic";

/** Public page for ACE: choose bank (ACH, no fee) or card (3% added for credit cards). */
export default async function AcePayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const o = await acePayOptions(token);
  if ("error" in o) {
    return (
      <main className="auth">
        <div className="card"><h1>Book Clarity</h1><p>{o.error}</p></div>
      </main>
    );
  }
  return (
    <main className="auth">
      <div className="card wide">
        <h1>Pay your Book Clarity batch</h1>
        <p>Amount due: <strong>{formatUsd(o.totalCents)}</strong>. Choose how you'd like to pay:</p>
        <a className="paybtn" href={`/pay/ace/${token}/bank`}>
          <strong>Bank account (ACH)</strong>
          <span>{formatUsd(o.totalCents)} · no fee</span>
        </a>
        <a className="paybtn" href={`/pay/ace/${token}/card`}>
          <strong>Card</strong>
          <span>
            {o.creditCardFeeCents > 0
              ? `${formatUsd(o.totalCents + o.creditCardFeeCents)} with a credit card (includes a 3% processing fee of ${formatUsd(o.creditCardFeeCents)}) · ${formatUsd(o.totalCents)} with a debit card`
              : formatUsd(o.totalCents)}
          </span>
        </a>
        <p className="muted">Payments are processed securely by Stripe.</p>
      </div>
    </main>
  );
}
