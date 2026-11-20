export default async function SetupComplete({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const { cancelled } = await searchParams;
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
