import { requirePermission } from "@/auth/permissions";
import { signedContracts } from "@/onboarding/contractCopies";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";

export const dynamic = "force-dynamic";

/** Every agreement a client has signed, with the fully signed PDF to download. */
export default async function SignedAgreementsPage() {
  const viewer = await requirePermission("ace.manage");
  const rows = await signedContracts();
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/onboarding">← Onboarding</a></p>
        <h2>Signed agreements</h2>
        <p className="muted">Each fully signed copy was emailed to the client, the countersigner and the office copy address (Settings → Onboarding). The PDF is rebuilt from exactly what was signed, with the signing record.</p>
        <section className="panel">
          <table>
            <thead><tr><th>Client</th><th>Package</th><th>Signed by client</th><th>Countersigned</th><th>Copy</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="muted">No signed agreements yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.onboardingId}>
                  <td><a href={`/clients/${r.clientId}`}>{r.clientName}</a></td>
                  <td>{r.packageName ?? "—"}</td>
                  <td>{r.signerName} · {fmtDate(r.signedAt)}</td>
                  <td>{r.countersignedAt ? fmtDate(r.countersignedAt) : <a href={`/contracts/${r.onboardingId}`}>Countersign</a>}</td>
                  <td>{r.countersignedAt ? <a href={`/contracts/${r.onboardingId}/pdf`}>Download PDF</a> : <span className="muted">after countersigning</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
