export default async function SetupComplete({ searchParams }: { searchParams: Promise<{ cancelled?: string; ace?: string }> }) {
  const { cancelled, ace } = await searchParams;
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
