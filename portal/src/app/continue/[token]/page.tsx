import { verifyLink } from "@/lib/links";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Public page for ACE clients: continue directly with Book Clarity, or not. */
export default async function ContinuePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const clientId = verifyLink("ace-continue", token);
  const client = clientId ? await db.client.findUnique({ where: { id: clientId } }) : null;
  if (!client || client.type !== "ACE") {
    return (
      <main className="auth">
        <div className="card"><h1>Book Clarity</h1><p>This link isn't valid. Please use the link Book Clarity sent you.</p></div>
      </main>
    );
  }
  return (
    <main className="auth">
      <div className="card wide">
        <h1>Continue with Book Clarity?</h1>
        <p>
          Hi {client.name}, your ACE-sponsored bookkeeping {client.acePrepaidUntil ? <>ends on <strong>{fmtDate(client.acePrepaidUntil)}</strong></> : "is ending soon"}.
          Would you like to keep working with us by paying Book Clarity directly each month?
        </p>
        <form method="post" action={`/continue/${token}/yes`}>
          <button type="submit" className="paybtn">
            <strong>Yes, continue</strong>
            <span>Set up monthly autopay by bank account (no fee) or card. Your first payment is the day after your ACE period ends.</span>
          </button>
        </form>
        <form method="post" action={`/continue/${token}/no`}>
          <button type="submit" className="paybtn">
            <strong>No thanks</strong>
            <span>Your service continues until the end of your ACE period. You can change your mind until then.</span>
          </button>
        </form>
      </div>
    </main>
  );
}
