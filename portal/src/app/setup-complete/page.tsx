export default async function SetupComplete({ searchParams }: { searchParams: Promise<{ cancelled?: string; ace?: string; updated?: string; onboarded?: string; onboarding?: string }> }) {
  const { cancelled, ace, updated, onboarded, onboarding } = await searchParams;
  if (onboarded) {
    return (
      <main className="auth">
        <div className="card"><h1>You're all set</h1><p>Thank you for completing your onboarding. We look forward to meeting you on your onboarding call. Your monthly billing starts 14 days after your onboarding fee was paid.</p></div>
      </main>
    );
  }
  if (onboarding) {
    return (
      <main className="auth">
        <div className="card">
          <h1>{cancelled ? "Payment not finished" : "Thank you"}</h1>
          <p>{cancelled ? "Nothing was charged. Use your onboarding link to continue whenever you're ready." : "Your onboarding fee is being processed. Return to your onboarding link to continue with the next step."}</p>
          <p><a href={`/onboard/${onboarding}`}>Continue onboarding</a></p>
        </div>
      </main>
    );
  }
  if (updated) {
    return (
      <main className="auth">
        <div className="card"><h1>Thank you</h1><p>Your payment details are up to date. Any outstanding payment will be retried automatically.</p></div>
      </main>
    );
  }
  if (ace) {
    return (
      <main className="auth">
        <div className="card">
          <h1>{cancelled ? "Payment not finished" : "Thank you"}</h1>
          <p>
            {cancelled
              ? "No card was charged. Use the link Book Clarity sent you whenever you're ready."
              : "Your card is being charged for this batch. You'll receive a receipt from Stripe by email."}
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="auth">
      <div className="card">
        <h1>{cancelled ? "Setup not finished" : "You're all set"}</h1>
        <p>
          {cancelled
            ? "No payment method was saved. Use the link Book Clarity sent you whenever you're ready."
            : "Thank you. Your payment method is saved for autopay, and your first monthly charge is the day after your prepaid period ends."}
        </p>
      </div>
    </main>
  );
}
