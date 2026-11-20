import { requirePermission } from "@/auth/permissions";
import { IMPORT_TEMPLATE } from "@/migration/commissionImport";
import { PortalHeader } from "@/app/PortalHeader";
import { ImportForm } from "./Form";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const viewer = await requirePermission("ace.manage");
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/commissions">← Commissions</a></p>
        <h2>Import the commission spreadsheet</h2>
        <section className="panel pad">
          <p>One row per client. Matching uses the Stripe customer ID (<code>cus_…</code>), then the email, then the exact name. Nothing changes until you press Apply, and importing the same file again changes nothing.</p>
          <ul>
            <li><strong>client</strong>: name, email or Stripe customer ID</li>
            <li><strong>type</strong>: Direct or ACE (leave blank to keep)</li>
            <li><strong>executive_1, rate_1, executive_2, rate_2</strong>: who earns and their % (e.g. Jose 5%, Albert 5%)</li>
            <li><strong>months_already_earned</strong>: commission months already earned or paid by hand, up to the "settled up to" date below. Direct clients: 0–12. ACE clients: only the paid months after the six ACE prepaid (0–6).</li>
            <li><strong>effective_from</strong>: optional date the split started (default: always)</li>
            <li><strong>ace_batch, ace_start_date</strong>: ACE clients only: the batch (its note or purchase date) and the client's start date. Enter past batches first on the ACE page and tick "Historical". A client already on Stripe autopay can only go into a historical batch.</li>
          </ul>
          <p><a download="commission-import-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE)}`}>Download the template</a></p>
        </section>
        <section className="panel pad"><ImportForm /></section>
      </main>
    </>
  );
}
