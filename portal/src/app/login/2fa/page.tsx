import { redirect } from "next/navigation";
import { getCurrentSession } from "@/auth/current";
import { db } from "@/lib/db";
import { TotpForm } from "./TotpForm";

export const dynamic = "force-dynamic";

export default async function TwoFactorPage() {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (s.twoFactorVerified) redirect("/");
  const user = await db.user.findUniqueOrThrow({ where: { id: s.user.id }, select: { totpSecret: true } });

  return (
    <main className="auth">
      <div className="card">
        <h1>Two-step sign-in</h1>
        {user.totpSecret ? (
          <>
            <p>Enter the 6-digit code from your authenticator app.</p>
            <TotpForm />
          </>
        ) : (
          <p>Your authenticator app hasn't been set up yet. Ask the Super Admin to set it up for you.</p>
        )}
      </div>
    </main>
  );
}
