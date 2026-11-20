"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Provisioned } from "@/users/provision";

/** Shows a new user's sign-in details once. Nothing here can be retrieved again later. */
export function CredentialsCard({ c, loginUrl }: { c: Provisioned; loginUrl: string }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (c.otpauthUrl) QRCode.toDataURL(c.otpauthUrl).then(setQr);
  }, [c.otpauthUrl]);
  return (
    <div className="creds">
      <p><strong>Save these now. They won't be shown again.</strong> Share them with {c.name} privately.</p>
      <dl>
        <dt>Sign-in page</dt><dd><code>{loginUrl}</code></dd>
        <dt>Email</dt><dd><code>{c.email}</code></dd>
        <dt>Temporary password</dt><dd><code>{c.password}</code></dd>
        <dt>Role</dt><dd>{c.role.replace("_", " ").toLowerCase()}</dd>
        {c.totpSecret && (<><dt>Authenticator key</dt><dd><code>{c.totpSecret}</code></dd></>)}
      </dl>
      {qr && (
        <>
          <p>Scan with Google Authenticator, Microsoft Authenticator or 1Password:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="Authenticator QR code" width={180} height={180} />
        </>
      )}
    </div>
  );
}
