# Book Clarity Portal: Build Roadmap

Spec: `docs/superpowers/specs/2026-11-19-client-portal-design.md`

The spec covers six largely independent subsystems. Each gets its own plan, and each plan ships working, tested software. Plans are written just before they're executed, so each one builds on the code that actually exists by then.

| # | Plan | Spec sections | Depends on |
|---|---|---|---|
| 1 | **Foundation and billing core:** scaffold, DB, auth + roles, Stripe webhooks, client status, 3% card fee, discounts | 4, 5, 6, 7.1–7.3, 15 | none |
| 2 | **Commission engine:** splits, earning windows, clawbacks, monthly statements, mark paid | 9, 19 (Q1, Q3), 18 (D3, D5) | 1 |
| 3 | **ACE batches:** batch invoices, out-of-band payments, slots, month-6 flow | 7.4, 18 (D6) | 1, 2 |
| 4 | **GHL and onboarding:** contact sync, workflows/reminders, onboarding flow, e-sign, calendars, strategy reviews | 8, 10, 11, 16 (R1), 18 (D1, D4), 19 (Q2) | 1, 3 |
| 5 | **Dashboards and reports:** role-scoped screens, week/month/year reports, CSV/PDF export | 12, 13 | 1–4 |
| 6 | **Migration and launch:** Stripe read-only sync, spreadsheet import, historical ACE batches, go-live checklist | 14, 17, 18 (D2), 7.3 launch items | 1–5 |

Plan 1: `docs/superpowers/plans/2026-11-19-plan-1-foundation-billing-core.md`
