import { requirePermission } from "@/auth/permissions";
import { db } from "@/lib/db";
import { listPackages } from "@/packages/packages";
import { getAceContactEmail, getAceCustomerId } from "@/ace/batches";
import { formatUsd } from "@/lib/money";
import { PortalHeader } from "@/app/PortalHeader";
import { AceContactForm, AceCustomerForm, ContractForm, PackageForm } from "@/app/ace/Forms";
import { contractFor } from "@/packages/contracts";
import { getLiveSnapshot } from "@/stripe/liveSnapshot";
import { priceChangeView } from "@/billing/priceChangeView";
import { PRICE_NOTICE_DAYS } from "@/domain/priceChange";
import { fmtDate } from "@/lib/format";
import { CancelPriceIncrease, PriceIncreaseForm } from "./PriceIncrease";

export const dynamic = "force-dynamic";
const dollars = (c: number) => (c / 100).toFixed(2);

export default async function PackagesPage() {
  const viewer = await requirePermission("ace.manage");
  const [packages, aceCustomer, aceContact] = await Promise.all([listPackages(), getAceCustomerId(), getAceContactEmail()]);
  const contracts = await Promise.all(packages.map((p) => contractFor(p)));
  const rows = await getLiveSnapshot().then((s) => s.rows).catch(() => null);
  const views = await Promise.all(packages.map((p) => (p.isCustom ? null : priceChangeView(p.id, p.monthlyPriceCents, rows))));
  const TZ = process.env.BUSINESS_TZ ?? "America/New_York";
  const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
  const earliest = ymd(new Date(Date.now() + PRICE_NOTICE_DAYS * 86400_000));
  const nextJan1 = `${new Date().getFullYear() + 1}-01-01`;
  const suggested = nextJan1 >= earliest ? nextJan1 : earliest;
  const unlinked = await db.client.findMany({ where: { packageId: null, endedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, stripeSubscriptionId: true } });
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Packages</h2>
        {unlinked.length > 0 && (
          <details className="panel pad">
            <summary><strong>{unlinked.length} active client{unlinked.length === 1 ? "" : "s"} not linked to a package</strong> <span className="muted">· linked automatically from Stripe when a package's name or Stripe price matches; otherwise set it in the import</span></summary>
            <ul className="plain">{unlinked.map((c) => <li key={c.id}><a href={`/clients/${c.stripeSubscriptionId ?? c.id}`}>{c.name}</a></li>)}</ul>
          </details>
        )}
        <p className="muted">The monthly price is the list price used for ACE commission (6 × monthly). Link each package to its Stripe price so ACE clients who continue can be put on autopay.</p>
        {packages.map((p, i) => (
          <section className="panel pad" key={p.id}>
            <h3>{p.name} <span className="muted">· {p.isCustom ? "Custom" : `${formatUsd(p.monthlyPriceCents)}/mo`}</span></h3>
            <PackageForm pkg={{ id: p.id, name: p.name, monthly: dollars(p.monthlyPriceCents), onboarding: dollars(p.onboardingFeeCents), isCustom: p.isCustom, stripePriceId: p.stripePriceId ?? "" }} />
            {contracts[i] ? (
              <ContractForm packageId={p.id} template={contracts[i]!.template} version={contracts[i]!.version} isDefault={!p.contractTemplate} />
            ) : (
              <ContractForm packageId={p.id} template="" version="none" isDefault={false} />
            )}
            {views[i] && (
              <div className="price-change">
                <h4>Price increase</h4>
                {views[i]!.change ? (
                  <>
                    <p>
                      <strong>
                        {formatUsd(views[i]!.change!.oldMonthlyCents)} → {formatUsd(views[i]!.change!.newMonthlyCents)}/month
                      </strong>{" "}
                      starting {fmtDate(views[i]!.change!.effectiveAt)}.{" "}
                      {views[i]!.change!.packageSwitched ? "New clients now pay the new price." : "New clients pay it from that date."}{" "}
                      Current clients move at their first bill on or after it, after a {PRICE_NOTICE_DAYS}-day notice.
                    </p>
                    <ul className="plain">
                      <li>Notices sent: {views[i]!.change!.noticed}</li>
                      <li>
                        Moved to the new price: {views[i]!.change!.moved.length}
                        {views[i]!.change!.moved.length > 0 && <span className="muted"> ({views[i]!.change!.moved.map((m) => `${m.name}, from ${fmtDate(m.startsOn)}`).join("; ")})</span>}
                      </li>
                      {views[i]!.preview && <li>Still to move: {views[i]!.preview!.willMove.length}{views[i]!.preview!.willMove.length > 0 && <span className="muted"> ({views[i]!.preview!.willMove.join(", ")})</span>}</li>}
                    </ul>
                    {views[i]!.change!.canCancel && <CancelPriceIncrease priceChangeId={views[i]!.change!.id} />}
                  </>
                ) : !p.stripePriceId ? (
                  <p className="muted">Add this package's Stripe price ID above to schedule a price increase.</p>
                ) : (
                  <>
                    <p className="muted">
                      New clients pay the new price from the start date. Current clients on the full {formatUsd(p.monthlyPriceCents)} price move at their first bill on or after it and get an email {PRICE_NOTICE_DAYS} days before.
                      {views[i]!.preview && <> That&apos;s {views[i]!.preview!.willMove.length} current client{views[i]!.preview!.willMove.length === 1 ? "" : "s"} today.</>}
                    </p>
                    <PriceIncreaseForm packageId={p.id} packageName={p.name} currentPrice={`${formatUsd(p.monthlyPriceCents)}/month`} earliest={earliest} suggested={suggested} />
                  </>
                )}
                {views[i]!.preview && views[i]!.preview!.notChanged.length > 0 && (
                  <details>
                    <summary>{views[i]!.preview!.notChanged.length} client{views[i]!.preview!.notChanged.length === 1 ? "" : "s"} not changed by a price increase (review by hand)</summary>
                    <ul className="plain">
                      {views[i]!.preview!.notChanged.map((n) => <li key={n.name}>{n.name} <span className="muted">· {formatUsd(n.monthlyCents)}/month · {n.why}</span></li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
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
