import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { getCurrentSession } from "@/auth/current";
import { startTotpEnrolment } from "@/auth/actions";
import { TotpForm } from "./TotpForm";

export const dynamic = "force-dynamic";

export default async function TwoFactorPage() {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (s.twoFactorVerified) redirect("/");

  const enrol = s.user.totpEnabled ? null : await startTotpEnrolment();
  const qr = enrol ? await QRCode.toDataURL(enrol.otpauthUrl) : null;

  return (
    <main className="auth">
      <div className="card">
        <h1>Two-step sign-in</h1>
        {enrol ? (
          <>
            <p>Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr!} alt="Authenticator QR code" width={180} height={180} />
            <p className="muted">
              Can't scan? Enter this key: <code>{enrol.secret}</code>
            </p>
          </>
        ) : (
          <p>Enter the 6-digit code from your authenticator app.</p>
        )}
        <TotpForm />
      </div>
    </main>
  );
}
