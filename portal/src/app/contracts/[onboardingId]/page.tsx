import { notFound } from "next/navigation";
import { requirePermission } from "@/auth/permissions";
import { countersignView } from "@/onboarding/countersign";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { CountersignButton } from "./CountersignButton";

export const dynamic = "force-dynamic";

export default async function ContractPage({ params }: { params: Promise<{ onboardingId: string }> }) {
  const viewer = await requirePermission("ace.manage");
  const { onboardingId } = await params;
  const c = await countersignView(onboardingId);
  if (!c) notFound();
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/onboarding">← Onboarding</a></p>
        <h2>{c.clientName} · {c.packageName ?? "Agreement"}</h2>
        <section className="panel pad">
          <p>
            Signed by <strong>{c.signerName}</strong> on {fmtDate(c.signedAt)} from IP {c.signerIp}. Contract version {c.contractVersion}.
            <br /><span className="muted">Fingerprint (SHA-256) of the signed text: <code>{c.signedHash}</code></span>
          </p>
          {c.countersignedAt ? (
            <p className="form-ok">Countersigned by {c.countersignedBy} on {fmtDate(c.countersignedAt)}. The fully signed copy was emailed to the client, the countersigner and the office copy address. <a href={`/contracts/${c.id}/pdf`}>Download PDF</a></p>
          ) : (
            <CountersignButton onboardingId={c.id} signerName={viewer.name} today={new Date().toLocaleDateString("en-US", { timeZone: process.env.BUSINESS_TZ ?? "America/New_York", dateStyle: "long" })} />
          )}
        </section>
        <section className="panel pad">
          <pre className="contract">{c.text}</pre>
          {(c.signatureImage || c.countersignatureImage) && (
            <div className="sig-images">
              {c.signatureImage && (
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.signatureImage} alt={`Signature of ${c.signerName}`} />
                  <figcaption>Client: {c.signerName} · {fmtDate(c.signedAt)}</figcaption>
                </figure>
              )}
              {c.countersignatureImage && (
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.countersignatureImage} alt={`Signature of ${c.countersignedBy}`} />
                  <figcaption>Book Clarity, LLC: {c.countersignedBy} · {fmtDate(c.countersignedAt)}</figcaption>
                </figure>
              )}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
