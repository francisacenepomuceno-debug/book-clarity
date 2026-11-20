import { requirePermission } from "@/auth/permissions";
import { launchStatus } from "@/settings/launch";
import { fmtDate } from "@/lib/format";
import { PortalHeader } from "@/app/PortalHeader";
import { CardFeeForm, CheckToggle, NoticesSwitch } from "./Forms";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  const viewer = await requirePermission("settings.manage");
  const s = await launchStatus();
  const autoDone = s.automatic.filter((a) => a.ok).length;
  const manualDone = s.manual.filter((m) => m.done).length;
  return (
    <>
      <PortalHeader role={viewer.role} viewerName={viewer.name} />
      <main>
        <p><a href="/">← Dashboard</a></p>
        <h2>Launch</h2>
        <p className="muted">Follow "Go-live" in the deploy guide. Client notices and the 3% card fee stay off until you turn them on here, and each switch checks what it depends on first.</p>

        <div className="two-col">
          <section className="panel pad">
            <h3>Client notices: {s.noticesOn ? <span className="s-CURRENT">on</span> : <span className="s-PAST_DUE">off</span>}</h3>
            <p className="muted">Payment reminders, onboarding links, ACE notices and staff alerts by email and text through GHL. While off, nothing is sent; it's recorded as skipped and isn't sent later. Onboarding links can still be copied from the Onboarding page.</p>
            <NoticesSwitch on={s.noticesOn} />
          </section>
          <section className="panel pad">
            <h3>3% credit-card fee: {s.cardFee.enabled ? <span className="s-CURRENT">on</span> : <span className="s-PAST_DUE">off</span>}</h3>
            <p className="muted">Added to monthly invoices paid by credit card (not debit or bank). Turn on only after clients have been given notice.</p>
            <CardFeeForm enabled={s.cardFee.enabled} ratePercent={s.cardFee.rateBasisPoints / 100} states={s.cardFee.excludedStates.join(", ")} />
          </section>
        </div>

        <section className="panel pad">
          <h3>Checked automatically ({autoDone} of {s.automatic.length})</h3>
          <ul className="plain checklist">
            {s.automatic.map((a) => (
              <li key={a.key}><span className={a.ok ? "s-CURRENT" : "s-PAST_DUE"}>{a.ok ? "✓" : "✗"}</span> {a.label}{a.detail && <span className="muted"> · {a.detail}</span>}</li>
            ))}
          </ul>
        </section>
        <section className="panel pad">
          <h3>Confirm by hand ({manualDone} of {s.manual.length})</h3>
          <ul className="plain checklist">
            {s.manual.map((m) => (
              <li key={m.key}>
                <span className={m.done ? "s-CURRENT" : "muted"}>{m.done ? "✓" : "○"}</span> {m.label}
                {m.done && m.at && <span className="muted"> · {m.by}, {fmtDate(new Date(m.at))}</span>}{" "}
                <CheckToggle k={m.key} done={m.done} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
