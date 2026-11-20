import { requirePermission } from "@/auth/permissions";
import { listPackages } from "@/packages/packages";
import { getAceContactEmail, getAceCustomerId } from "@/ace/batches";
import { formatUsd } from "@/lib/money";
import { PortalHeader } from "@/app/PortalHeader";
import { AceContactForm, AceCustomerForm, PackageForm } from "@/app/ace/Forms";

export const dynamic = "force-dynamic";
const dollars = (c: number) => (c / 100).toFixed(2);

export default async function PackagesPage() {
  const viewer = await requirePermission("ace.manage");
  const [packages, aceCustomer, aceContact] = await Promise.all([listPackages(), getAceCustomerId(), getAceContactEmail()]);
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Packages</h2>
        <p className="muted">The monthly price is the list price used for ACE commission (6 × monthly). Link each package to its Stripe price so ACE clients who continue can be put on autopay.</p>
        {packages.map((p) => (
          <section className="panel pad" key={p.id}>
            <h3>{p.name} <span className="muted">· {p.isCustom ? "Custom" : `${formatUsd(p.monthlyPriceCents)}/mo`}</span></h3>
            <PackageForm pkg={{ id: p.id, name: p.name, monthly: dollars(p.monthlyPriceCents), onboarding: dollars(p.onboardingFeeCents), isCustom: p.isCustom, stripePriceId: p.stripePriceId ?? "" }} />
          </section>
        ))}
        <section className="panel pad">
          <h3>Add a package</h3>
          <PackageForm />
        </section>
        <section className="panel pad">
          <h3>ACE billing</h3>
          <p className="muted">The Stripe customer that ACE batch invoices are sent to. Create ACE as a customer in Stripe (with ACE's billing email), then paste its ID here.</p>
          <AceCustomerForm current={aceCustomer ?? ""} />
          <AceContactForm current={aceContact ?? ""} />
        </section>
      </main>
    </>
  );
}
