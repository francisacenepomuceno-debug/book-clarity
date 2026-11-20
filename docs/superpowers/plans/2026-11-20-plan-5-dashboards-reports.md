# Plan 5: Dashboards and Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners can see:
- how the business is doing, by week, month or year, compared with the previous period, with export to CSV and PDF;
- an Owner dashboard that flags what needs attention.

Every staff role gets a Payments view, and Owners get an audit log.

**Architecture:**
- **Reports:** computed on request from the portal's own tables (Invoice, Client, AceBatch, AceSlot, Discount, CommissionEntry/Statement). Nothing is stored.
- **Periods:** a pure period module turns (week | month | year, anchor date) into business-timezone bounds and the previous period.
- **Report functions:** each returns plain rows, shared by the page, the CSV export and the PDF export.
- **PDFs:** generated server-side with `pdf-lib`, which is pure JS and runs on Vercel without a browser.
- **History:** a read-only backfill script pulls past Stripe invoices into the portal so reports have history from day one.

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md` §4 (roles), §12 (screens), §13 (reports).

## Global Constraints

- **Basis (spec §13):**
  - Revenue is **cash collected, by payment date** in `BUSINESS_TZ` (America/New_York).
  - An ACE batch counts on the date it was paid (`AceBatch.paidAt`, any payment method).
  - No accrual reporting.
- **Periods:**
  - **Week:** Monday 00:00 to the next Monday 00:00.
  - **Month:** calendar month.
  - **Year:** calendar year.
  - Everything is in `BUSINESS_TZ`.
  - Every report also shows the previous period of the same kind and the change between them.
- **Access:**
  - Reports, the Owner dashboard, the audit log and exports need `reports.view` / `audit.view` (Owner and Super Admin), checked on the server for every page and export route.
  - The Payments view is open to all staff (`payments.view`). Amounts are shown only with `payments.viewAmounts`; Admins see statuses only, and their rows never include money fields.
- **Money:** integer cents throughout, formatted only at display time.
- **Refunds:** the portal stores refunded amounts on the invoice but not the refund date. Revenue is shown **net of refunds, attributed to the original payment's period**. This is a documented limit; refund dates can be added later.

## Review Focus

1. **Time-zone boundaries.** A payment at 11:30 pm New York time on the 31st counts in that month, not the next (it is already the 1st in UTC). Covered by Task 1 and Task 2 tests.
2. **Money in Admin responses.** An Admin never receives amounts: not on the Payments page, not from an export route (403). Covered by Task 4 and Task 5 tests.
3. **Double counting.**
   - An ACE batch is counted once, as an ACE payment and never as a client invoice.
   - The card fee and the onboarding fee are split out of the invoice total, not added to it.
   - Covered by Task 2 tests.
4. **Empty periods** render zeros, not errors, and a change from 0 shows as "new", not a division by zero. Covered by Task 1 and Task 2 tests.

---

### Task 1: Periods

`src/domain/periods.ts`, pure:
- `periodOf(kind, anchor: Date, tz) → { kind, start, end, label, key }`, where `key` is `2026-W47`, `2026-11` or `2026`;
- `previous(p)`;
- `parsePeriod(kind, key)`;
- `bucketsBetween(kind, start, end)`, the list of periods for trend charts;
- `change(current, previous) → { delta, pct | null }`, where `pct` is null when the previous value is 0.

Tests:
- an 11:30 pm New York payment on Nov 30 falls in November;
- weeks start on Monday;
- moving back from January gives December of the previous year;
- 53-week years;
- DST transitions.

### Task 2: Report queries

`src/reports/*.ts`. Each function takes `(period)` and returns rows plus totals for the current and the previous period.

1. **`revenue`:** collected by type and by package.
   - Types: monthly packages = paid SUBSCRIPTION invoices' `amountPaid − cardFee − onboarding − tax`; onboarding fees (`onboardingCents` on any paid invoice); card fees; ACE payments (`AceBatch.totalCents` by `paidAt`).
   - Refunds are subtracted.
   - Per package: the client's package.
2. **`expectedVsCollected`:**
   - Expected: SUBSCRIPTION invoices whose billing period starts in the period, excluding void and draft.
   - Collected: of those, the amount paid.
   - Outstanding past due: open invoices with a failed payment as of the period end.
3. **`newClients`:**
   - A client's start date is the onboarding fee payment date, else the ACE slot start date, else their first paid subscription invoice.
   - Counted by package and by Direct/ACE.
4. **`endedClients`:** clients with `endedAt` in the period, with type and package.
5. **`aceContinuation`:**
   - ACE clients whose prepaid time ended in the period.
   - "Continued" means they have a subscription or a CONTINUING decision; "ended" means `endedAt` is set.
   - Rate = continued ÷ (continued + ended). Clients still undecided are listed separately.
6. **`activeAndMrr(kind, n)`:** for the last n buckets:
   - **Active clients:** distinct clients with a non-void SUBSCRIPTION invoice whose period starts in the bucket, plus ACE clients prepaid during the bucket.
   - **MRR:** the sum of those invoices' `subtotal − discount − cardFee − onboarding`.
7. **`discountsGiven`:** the sum of `discountCents` on paid invoices, per client.
8. **`commissions`:**
   - Per executive: earned (EARNED + ACE_PREPAID), clawbacks and net, by `occurredAt` in the period.
   - Paid vs unpaid, from the status of each statement month.

Tests:
- one fixture set per report, including the ACE batch counted once, the time-zone boundary and empty periods;
- for every report, the previous-period figures.

### Task 3: Reports page and exports

- **`/reports`** (`reports.view`):
  - period kind tabs (Week / Month / Year) and previous/next arrows;
  - one section per report, each showing current, previous and change;
  - a 12-bucket trend chart for active clients and MRR, drawn as inline SVG (follow the dataviz skill);
  - a "Download CSV" and a "Download PDF" link per report, plus "everything".
- **`/api/reports/[report]`** returns `?period=month&key=2026-11&format=csv|pdf`:
  - CSV is RFC 4180, cells are quoted, and formula-leading cells (`= + - @`) get a leading `'`;
  - PDF is built with pdf-lib: a title, the period, and a table with page breaks;
  - the route returns 403 without `reports.view`.
- Tests: CSV escaping and formula guard; the route's 403 for an Admin; the PDF is non-empty and starts with `%PDF`.

### Task 4: Owner dashboard additions

On `/`, for Owners and Super Admins only (`reports.view`):
- **This month:**
  - expected vs collected, with a progress bar;
  - outstanding past due.
- **Alerts** (each item links to the client or batch):
  - payments declined in the last 7 days;
  - At-risk and Suspended clients;
  - ACE clients within 60 days of month 6 with no decision;
  - ACE batches with open slots;
  - discounts ending in the next 30 days (start + months);
  - onboarding stuck for more than 3 days;
  - contracts waiting for countersignature.

`src/reports/alerts.ts` → `dashboardAlerts(now)`.

Tests: each alert appears and disappears at its threshold; an Admin's dashboard has no expected/collected panel and no alerts panel.

### Task 5: Payments view

`/payments` (`payments.view`), with a month picker defaulting to this month. It shows each client's SUBSCRIPTION invoice for the month:
- status: Paid (date), Failed (date of the first failure), Processing (bank), Open (not yet due), Suspended;
- payment method;
- amount, Owners only.

It also has filters and counts per status.

`src/payments/monthly.ts` → `monthlyPayments(month, role)`. For roles without `payments.viewAmounts` the money fields are stripped in the query layer, the same way `scopeRow` works.

Tests: an Admin gets no amount fields; a client billed twice in a month shows both invoices; ACE-prepaid clients are listed as "Prepaid by ACE".

### Task 6: Audit log

`/audit` (`audit.view`), paginated 50 at a time, newest first. It can be filtered by action, by person and by client or entity id. Each row shows who, what and when, with a before/after diff (keys that changed).

Tests: an Admin gets 403; the filters work; pagination is stable.

### Task 7: Invoice history backfill (read-only)

`scripts/backfill-invoices.ts [--since 2025-01-01]` reads Stripe invoices and stores each one with the existing `upsertInvoiceFromStripe` (skipping customers who aren't portal clients). It:
- pages through `invoices.list` with expanded payments to get the method;
- is idempotent and never writes to Stripe;
- prints counts.

The deploy guide gets a section on running it once after the client sync.

Tests: running it twice over the same fake pages gives the same rows; it makes no Stripe write calls.

### Task 8: Navigation and smoke

- **Header links:** Payments (all staff), Reports and Audit (Owners).
- **Smoke test:**
  - an Owner opens Reports, switches to Week and downloads a CSV and a PDF;
  - an Admin opens Payments with no `$` in it, and gets 403 on `/reports` and on the export route.

## Done when

- CI is green.
- The smoke test covers Reports, exports and Payments.
- The final review is clean.
