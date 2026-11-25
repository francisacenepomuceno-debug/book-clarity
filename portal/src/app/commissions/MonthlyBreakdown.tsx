import { addMonths, monthlyBreakdown } from "@/commissions/breakdown";
import { formatUsd } from "@/lib/money";
import { fmtDate, fmtMonth } from "@/lib/format";

/** Each executive's commission for one month, client by client and grouped by package (like the commission tracker). */
export async function MonthlyBreakdown({ month, thisMonth }: { month: string; thisMonth: string }) {
  const execs = await monthlyBreakdown(month);
  const link = (m: string) => `/commissions?month=${m}#breakdown`;
  return (
    <section className="panel pad" id="breakdown">
      <div className="breakdown-head">
        <h3>Monthly breakdown · {fmtMonth(month)}</h3>
        <form method="get" action="/commissions#breakdown" className="inline-form">
          <a href={link(addMonths(month, -1))}>← {fmtMonth(addMonths(month, -1))}</a>
          <input type="month" name="month" defaultValue={month} aria-label="Month" />
          <button className="secondary">Show</button>
          {month !== thisMonth && <a href={link(thisMonth)}>This month</a>}
          <a href={link(addMonths(month, 1))}>{fmtMonth(addMonths(month, 1))} →</a>
        </form>
      </div>
      <p className="muted">
        Commission is earned when the client&apos;s payment clears, on the package amount (not the card fee or onboarding fee).
        {month >= thisMonth && " Rows marked “Awaiting payment” haven't paid this month yet; their amount is an estimate from the last payment."}
      </p>
      {execs.length === 0 && <p className="muted">No commission for {fmtMonth(month)}.</p>}
      {execs.map((ex) => (
        <div key={ex.executiveId} className="exec-breakdown">
          <h4>
            {ex.executiveName} · {formatUsd(ex.totalCents)} earned
            {ex.expectedCents > 0 && <span className="muted"> · {formatUsd(ex.expectedCents)} still expected</span>}
            {" · "}
            {ex.status === "PAID" ? <span className="s-CURRENT">Paid {fmtDate(ex.paidAt)}</span> : month < thisMonth ? <span className="s-PAST_DUE">Unpaid</span> : <span className="muted">In progress</span>}
            {ex.totalCents !== 0 && <> · <a href={`/commissions/${ex.executiveId}/${month}`}>statement</a></>}
          </h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Client</th><th>Payout</th><th>Final payout</th><th className="num">Client paid</th><th>Method</th><th className="num">Rate</th><th className="num">Commission</th><th>Notes</th>
                </tr>
              </thead>
              {ex.groups.map((g) => (
                <tbody key={g.packageName}>
                  <tr className="group-row">
                    <th colSpan={6}>{g.packageName}</th>
                    <th className="num">{formatUsd(g.totalCents)}</th>
                    <th className="muted">{g.expectedCents > 0 ? `+ ${formatUsd(g.expectedCents)} expected` : ""}</th>
                  </tr>
                  {g.rows.map((r, i) => (
                    <tr key={i} className={r.expected ? "expected" : undefined}>
                      <td><a href={r.href}>{r.clientName}</a></td>
                      <td>{r.payout}</td>
                      <td>{r.finalMonth ? fmtMonth(r.finalMonth) : "—"}</td>
                      <td className="num">{r.paidCents != null ? <>{formatUsd(r.paidCents)}<br /><span className="muted">{fmtDate(r.paidAt)}</span></> : "—"}</td>
                      <td>{r.method ?? "—"}</td>
                      <td className="num">{r.rateBp / 100}%</td>
                      <td className="num">{r.expected ? <span className="muted">~{formatUsd(r.commissionCents)}</span> : formatUsd(r.commissionCents)}</td>
                      <td>{r.notes.join(" · ") || ""}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
              <tfoot>
                <tr><th colSpan={6}>Total for {fmtMonth(month)}</th><th className="num">{formatUsd(ex.totalCents)}</th><th className="muted">{ex.expectedCents > 0 ? `+ ${formatUsd(ex.expectedCents)} expected` : ""}</th></tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
