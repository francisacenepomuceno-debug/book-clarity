import { requirePermission, can } from "@/auth/permissions";
import { listOnboardings, type OnboardingRow } from "@/onboarding/overview";
import { listPackages } from "@/packages/packages";
import { STEP_LABEL } from "@/domain/onboarding";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { NewClientForm, WaiveFeeButton } from "./Forms";
import { formatUsd } from "@/lib/money";

export const dynamic = "force-dynamic";
const STUCK_MS = 3 * 86400_000;

function Table({ rows, showStep, now, owner }: { rows: OnboardingRow[]; showStep?: boolean; now: number; owner: boolean }) {
  if (rows.length === 0) return <p className="muted">None.</p>;
  return (
    <table>
      <thead>
        <tr><th>Client</th><th>Type</th><th>Package</th>{showStep && <th>Current step</th>}<th>Started</th><th>Call booked</th><th>Contract</th>{owner && <th>Onboarding fee</th>}<th>Link</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.onboardingId}>
            <td><a href={`/clients/${r.clientId}`}>{r.name}</a><br /><span className="muted">{r.email}</span></td>
            <td>{r.type === "ACE" ? "ACE" : "Direct"}</td>
            <td>{r.packageName ?? "—"}</td>
            {showStep && (
              <td>
                {STEP_LABEL[r.step]}
                {now - r.lastProgressAt.getTime() > STUCK_MS && <span className="badge AT_RISK" style={{ marginLeft: 6 }}>Stuck</span>}
              </td>
            )}
            <td>{fmtDate(r.startedAt)}</td>
            <td>{r.callBookedAt ? fmtDate(r.callBookedAt) : "Not scheduled"}</td>
            <td>
              {!r.signedAt ? "Not signed" : r.countersignedAt ? "Fully signed" : owner ? <a href={`/contracts/${r.onboardingId}`}>Awaiting countersign</a> : "Awaiting countersign"}
            </td>
            {owner && (
              <td>
                {r.feeCents === 0 ? "Waived" : r.feeCents != null ? formatUsd(r.feeCents) : "—"}{" "}
                {r.feeWaivable && <WaiveFeeButton onboardingId={r.onboardingId} />}
              </td>
            )}
            <td><input readOnly value={r.link} style={{ width: 140 }} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function OnboardingPage() {
  const viewer = await requirePermission("onboarding.view");
  const [rows, packages] = await Promise.all([listOnboardings(), listPackages()]);
  const now = Date.now();
  const owner = can(viewer.role, "ace.manage");
  const notStarted = rows.filter((r) => r.lastProgressAt.getTime() === r.startedAt.getTime() && r.step !== "done");
  const inProgress = rows.filter((r) => r.step !== "done" && !notStarted.includes(r));
  const done = rows.filter((r) => r.step === "done");
  const awaitingCountersign = rows.filter((r) => r.signedAt && !r.countersignedAt);
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← All clients</a></p>
        <h2>Onboarding</h2>
        {can(viewer.role, "ace.manage") && <p><a href="/settings/onboarding">Onboarding settings</a> (questionnaire, countersigner, booking link, suspension)</p>}
        <section className="panel pad">
          <h3>New client</h3>
          <p className="muted">Creates the client and emails (and texts, if a phone is given) their onboarding link: package, details, agreement, onboarding fee, questionnaire, and booking the call.</p>
          <NewClientForm packages={packages.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, isCustom: p.isCustom }))} canSetPrices={can(viewer.role, "discounts.apply")} />
        </section>
        {can(viewer.role, "ace.manage") && awaitingCountersign.length > 0 && (
          <section className="panel pad">
            <h3>Waiting for countersignature ({awaitingCountersign.length})</h3>
            <Table rows={awaitingCountersign} showStep now={now} owner={owner} />
          </section>
        )}
        <section className="panel pad"><h3>In progress ({inProgress.length})</h3><Table rows={inProgress} showStep now={now} owner={owner} /></section>
        <section className="panel pad"><h3>Not started ({notStarted.length})</h3><Table rows={notStarted} now={now} owner={owner} /></section>
        <section className="panel pad"><h3>Done ({done.length})</h3><Table rows={done} now={now} owner={owner} /></section>
      </main>
    </>
  );
}
