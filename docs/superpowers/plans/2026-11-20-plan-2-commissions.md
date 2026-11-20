# Plan 2: Commission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Executives earn commission automatically from cleared client payments under Book Clarity's rules. Refunds come back off later statements. Owners see monthly statements per executive and mark them paid.

**Architecture:**
- **Pure rules** go in `src/domain/commission.ts`: base amount, split, earning window, clawback math and posting month.
- **A service layer** in `src/commissions/` writes an append-only `CommissionEntry` ledger, driven by the existing Stripe webhook (`invoice.paid`, plus a new `charge.refunded`). Every write is idempotent through unique keys.
- **Statements** are monthly views over the ledger. Paying one locks its month, and anything arriving later posts to the next open month.

**Tech Stack:** Same as Plan 1: Next.js 15, Prisma/Postgres, Vitest, Stripe SDK.

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md`. Read §9, §18 (D3, D5) and §19 (Q1, Q3).

## Global Constraints

- **Money:** integer cents. **Rates:** integer basis points (10% = `1000`). Round half-up once per line, using `percentOfCents` from `src/lib/money.ts`.
- **Commissionable base** = package amount actually paid, after discounts. It **excludes** onboarding fees, the 3% card fee and taxes. Refunds are clawbacks.
- **Default rate:** 10% (`1000` bp) to one executive. A shared client splits, e.g. Jose `500` + Albert `500`. The shares must add up to the client's total rate. Every share must be > 0, and the total ≤ `3000` (a 30% typo guard; the spec allows totals other than 10%).
- **Windows:** Direct = first **12** paid monthly invoices. **ACE months 1–6 lump sum and months 7–12 are Plan 3** (this plan must not block them; see `windowMonthsFor`).
- **$0 invoices** (100% discount) do **not** count toward a window (Q3).
- **Late payment:** counts in the month the money arrived. Months use the business timezone `BUSINESS_TZ`.
- **Rate or split changes** apply from a chosen date forward and never rewrite past entries.
- **Paid statements are locked.** Later entries for that month post to the first unpaid month after it.
- **Refunds:** a proportional negative line on the next open statement. This includes retroactive-discount refunds (D3).
- **Who can do what:** Owners and Super Admin can view (`commissions.view`), mark paid (`commissions.markPaid`) and set splits (`commissions.view`). Admins get nothing here.

## Review Focus

1. **A payment arrives for a client with no commission owner, and an Owner assigns one later.** That payment's commission appears exactly once. Covered by a Task 4 test.
2. **A refund comes in after the statement holding the original commission was marked paid.** The clawback lands on the next open month, and the paid statement's lines and total are unchanged. Covered by a Task 5 test.
3. **A 100%-off month in the middle of the window.** It earns nothing and doesn't use up one of the 12 months. Covered by a Task 3 test.
4. **The split changes mid-window.** Earlier payments keep the old split, and payments on or after the effective date use the new one. Covered by Task 1 and Task 4 tests.
5. **The same `invoice.paid` is delivered twice, or a recompute runs twice.** No duplicate ledger lines. Covered by a Task 3 test.

---

## File structure

```
portal/prisma/schema.prisma           + Executive, CommissionShare, CommissionEntry, CommissionStatement; Client/Invoice fields
portal/src/domain/commission.ts       pure rules
portal/src/commissions/engine.ts      recordPaymentCommission, recordRefundClawback, recomputeClient, postingMonthFor
portal/src/commissions/splits.ts      executives + setClientCommission
portal/src/commissions/statements.ts  listStatements, statementLines, markStatementPaid, commissionProgress
portal/src/stripe/handlers/refund.ts  charge.refunded → invoice refund totals + clawback
portal/src/app/commissions/...        pages
portal/src/app/clients/[subscriptionId]/CommissionForm.tsx
```

---

### Task 1: Schema and pure commission rules

**Files:**
- Modify: `portal/prisma/schema.prisma`
- Create: `portal/src/domain/commission.ts`
- Test: `portal/tests/domain/commission.test.ts`

**Interfaces:**
- Produces Prisma models:
  - `Executive { id, name @unique, active Boolean @default(true), createdAt }`
  - `CommissionShare { id, clientId, executiveId, rateBp Int, effectiveFrom DateTime, createdById String, createdAt }`, indexed on `(clientId, effectiveFrom)`. The rows sharing one `effectiveFrom` form one split version.
  - `enum CommissionKind { EARNED CLAWBACK }`
  - `CommissionEntry { id, executiveId, clientId, invoiceId String, kind CommissionKind, refundKey String @default(""), windowIndex Int?, baseCents Int, rateBp Int, amountCents Int, occurredAt DateTime, month String /* "YYYY-MM" */, createdAt }` with `@@unique([executiveId, invoiceId, kind, refundKey])`
  - `enum StatementStatus { OPEN PAID }`
  - `CommissionStatement { id, executiveId, month String, status StatementStatus, paidAt DateTime?, paidById String?, totalCents Int? }` with `@@unique([executiveId, month])`
- Adds the Client field `commissionMonthsBeforePortal Int @default(0)`, the paid months already earned before the portal existed.
- Adds the Invoice fields `onboardingCents Int @default(0)` and `refundedCents Int @default(0)`.
- Produces in `domain/commission.ts`:
  - `type Share = { executiveId: string; rateBp: number; effectiveFrom: Date }`
  - `packagePaidCents(i: { amountPaidCents: number; cardFeeCents: number; onboardingCents: number }): number`, which is `max(0, paid − fee − onboarding)`.
  - `splitAt(shares: Share[], at: Date): { executiveId: string; rateBp: number }[]`, the version with the latest `effectiveFrom ≤ at`, or `[]`.
  - `windowMonthsFor(client: { type: "DIRECT" | "ACE" }): number`. DIRECT → 12. ACE → 6 (months 7–12; Plan 3 adds the lump sum).
  - `earnedLines(i: { baseCents: number; paidIndex: number; windowMonths: number; split: { executiveId: string; rateBp: number }[] }): { executiveId: string; rateBp: number; amountCents: number }[]`. Returns `[]` when `baseCents ≤ 0` or `paidIndex > windowMonths`.
  - `clawbackLines(i: { originals: { executiveId: string; rateBp: number; amountCents: number }[]; refundPackageCents: number; invoicePackageCents: number; alreadyClawedByExec: Record<string, number> }): { executiveId: string; rateBp: number; amountCents: number }[]`. Amounts are negative and capped so the total clawed per executive never exceeds the original.
  - `monthOf(d: Date, tz: string): string` returns `"YYYY-MM"`.
  - `nextMonth(m: string): string`.
  - `validateSplit(shares: { executiveId: string; rateBp: number }[]): { ok: true } | { ok: false; error: string }`. Rejects an empty list, duplicates, any share ≤ 0 or > 1000, and a total > 1000.

- [ ] **Step 1: Write the failing test** `commission.test.ts`:
  ```ts
  expect(packagePaidCents({ amountPaidCents: 82400, cardFeeCents: 2400, onboardingCents: 0 })).toBe(80000);
  expect(packagePaidCents({ amountPaidCents: 1000, cardFeeCents: 2400, onboardingCents: 0 })).toBe(0);
  // split versions
  const v1 = [{ executiveId: "jose", rateBp: 1000, effectiveFrom: new Date("2026-01-01") }];
  const v2 = [{ executiveId: "jose", rateBp: 500, effectiveFrom: new Date("2026-06-01") }, { executiveId: "albert", rateBp: 500, effectiveFrom: new Date("2026-06-01") }];
  expect(splitAt([...v1, ...v2], new Date("2026-05-31"))).toEqual([{ executiveId: "jose", rateBp: 1000 }]);
  expect(splitAt([...v1, ...v2], new Date("2026-06-01"))).toEqual([{ executiveId: "jose", rateBp: 500 }, { executiveId: "albert", rateBp: 500 }]);
  expect(splitAt(v1, new Date("2025-12-31"))).toEqual([]);
  // windows
  expect(earnedLines({ baseCents: 65000, paidIndex: 12, windowMonths: 12, split: [{ executiveId: "jose", rateBp: 1000 }] })).toEqual([{ executiveId: "jose", rateBp: 1000, amountCents: 6500 }]);
  expect(earnedLines({ baseCents: 65000, paidIndex: 13, windowMonths: 12, split: [{ executiveId: "jose", rateBp: 1000 }] })).toEqual([]);
  expect(earnedLines({ baseCents: 0, paidIndex: 1, windowMonths: 12, split: [{ executiveId: "jose", rateBp: 1000 }] })).toEqual([]);
  expect(earnedLines({ baseCents: 33333, paidIndex: 1, windowMonths: 12, split: [{ executiveId: "j", rateBp: 500 }, { executiveId: "a", rateBp: 500 }] }).map((l) => l.amountCents)).toEqual([1667, 1667]);
  // clawback: half the package refunded → half back; never more than original
  expect(clawbackLines({ originals: [{ executiveId: "jose", rateBp: 1000, amountCents: 8000 }], refundPackageCents: 40000, invoicePackageCents: 80000, alreadyClawedByExec: {} })).toEqual([{ executiveId: "jose", rateBp: 1000, amountCents: -4000 }]);
  expect(clawbackLines({ originals: [{ executiveId: "jose", rateBp: 1000, amountCents: 8000 }], refundPackageCents: 80000, invoicePackageCents: 80000, alreadyClawedByExec: { jose: 6000 } })).toEqual([{ executiveId: "jose", rateBp: 1000, amountCents: -2000 }]);
  // months in business timezone: 2026-12-01 03:00Z is still November in New York
  expect(monthOf(new Date("2026-12-01T03:00:00Z"), "America/New_York")).toBe("2026-11");
  expect(nextMonth("2026-12")).toBe("2027-01");
  expect(validateSplit([{ executiveId: "j", rateBp: 600 }, { executiveId: "a", rateBp: 500 }]).ok).toBe(false);
  expect(validateSplit([{ executiveId: "j", rateBp: 700 }, { executiveId: "a", rateBp: 300 }]).ok).toBe(true);
  ```
- [ ] **Step 2:** Run `npx vitest run tests/domain/commission.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the module and the schema. Then run `npx prisma migrate dev --name commissions` and add the four new tables to the `TRUNCATE` list in `tests/helpers/db.ts`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): commission schema and pure rules`.

---

### Task 2: Track onboarding lines and refunds on invoices

**Files:**
- Modify: `portal/src/stripe/handlers/invoice.ts`, `portal/src/stripe/lines.ts`, `portal/src/stripe/webhook.ts`, `portal/src/stripe/deps.ts`
- Create: `portal/src/stripe/handlers/refund.ts`
- Test: `portal/tests/stripe/refundSync.test.ts`

**Interfaces:**
- Produces `isOnboardingLine(line): boolean` in `lines.ts`. It matches `/onboarding/i` on the description, or `metadata.kind === "ONBOARDING"`.
- `upsertInvoiceFromStripe` sets `onboardingCents` from the onboarding lines.
- Adds to `WebhookDeps`: `getInvoiceIdForCharge(charge: Stripe.Charge): Promise<string | null>`, which goes through invoice payments by payment intent, and `onRefund(invoiceRowId: string, refund: { refundKey: string; refundCents: number; packageCents: number }): Promise<void>`. The latter is a no-op until Task 3.
- `"charge.refunded"` is handled. It finds the invoice and sets `Invoice.refundedCents = charge.amount_refunded`. For each refund on the charge **not yet seen**, it calls `onRefund` with `refundKey = refund.id`. The refund's package share is `refund.metadata.discountCents` when present (a retroactive discount). Otherwise it is `round(refund.amount × invoicePackage / amountPaid)`.

- [ ] **Step 1: Write the failing test** `refundSync.test.ts`, with a test DB and fake deps:
  - An invoice with a line `"1 × Growth - Onboarding Fee"` of 50000 gives `onboardingCents = 50000`.
  - `charge.refunded` with `amount_refunded: 20600` and a refund `{ id: "re_1", amount: 20600, metadata: { bc_retro_discount: "1", discountCents: "20000", feeCents: "600" } }` sets `refundedCents = 20600` and calls `onRefund` once with `{ refundKey: "re_1", refundCents: 20600, packageCents: 20000 }`.
  - A plain refund of 41200 on a paid invoice (amountPaid 82400, fee 2400) calls `onRefund` with `packageCents: 40000`.
  - The same event delivered again calls `onRefund` 0 more times, thanks to event idempotency.
  - A charge with no invoice, or an unknown customer, is a no-op with result `"processed"`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it. Add `"charge.refunded"` to `HANDLED`. `defaultWebhookDeps.getInvoiceIdForCharge` uses `stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent } })`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): track onboarding lines and refunds on invoices`.

---

### Task 3: Ledger engine (earn and claw back, idempotent, locked months)

**Files:**
- Create: `portal/src/commissions/engine.ts`
- Modify: `portal/src/stripe/deps.ts`, where `onInvoicePaid` also calls `recordPaymentCommission` and `onRefund` calls `recordRefundClawback`.
- Test: `portal/tests/commissions/engine.test.ts`

**Interfaces:**
- Consumes everything from Task 1 and Task 2.
- Produces:
  - `postingMonthFor(executiveId: string, eventMonth: string): Promise<string>`. Returns `eventMonth`, unless that executive's statement for it (or a later one) is PAID. In that case it returns the month after their latest PAID statement.
  - `recordPaymentCommission(invoiceRowId: string): Promise<number>`, the number of new entries. It only acts on `kind = SUBSCRIPTION`, `status = paid` and a client with a split at `paidAt`.
    - `paidIndex = client.commissionMonthsBeforePortal + (number of that client's paid SUBSCRIPTION invoices with packagePaidCents > 0 and (paidAt, id) earlier than this one) + 1`.
    - Entries are written with `createMany({ skipDuplicates: true })`.
  - `recordRefundClawback(invoiceRowId: string, refund: { refundKey: string; packageCents: number }): Promise<number>`. It claws back from that invoice's EARNED entries, posting at the refund time.
  - `recomputeClient(clientId: string): Promise<number>`. It runs `recordPaymentCommission` for every paid invoice of that client, oldest first.

- [ ] **Step 1: Write the failing test** `engine.test.ts`. Use a test DB, seed Jose and Albert, and give the client a 10% Jose split from 2026-01-01.
  - **Payment:** an $800 invoice (fee 2400, paid 82400 on 2026-11-15) creates 1 EARNED entry: base 80000, rate 1000, amount 8000, month `"2026-11"`, windowIndex 1.
  - **Idempotent:** calling it twice still leaves 1 entry (Review Focus 5).
  - **Window:** `commissionMonthsBeforePortal = 11`. The next paid invoice gets windowIndex 12 and earns. The one after earns nothing.
  - **$0 month:** a $0 invoice (100% discount) between two paid ones earns nothing and doesn't use a window month (Review Focus 3). With `commissionMonthsBeforePortal = 10`, the paid months go $800 → $0 → $800 → $800: the third paid invoice is index 12 and earns, and the fourth is index 13 and doesn't.
  - **No split:** nothing is recorded and the result is 0.
  - **Refund:** a refund with packageCents 40000 creates CLAWBACK −4000 in the refund's month, and running it again adds nothing.
  - **Locked month:** a statement for Jose `"2026-11"` is PAID. A payment dated 2026-11-20 recorded afterwards posts to `"2026-12"`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it. Use `BUSINESS_TZ` (default `America/New_York`) for `monthOf`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): commission ledger engine`.

---

### Task 4: Executives and per-client commission setup

**Files:**
- Create: `portal/src/commissions/splits.ts`
- Test: `portal/tests/commissions/splits.test.ts`

**Interfaces:**
- Produces:
  - `addExecutive(name: string): Promise<ActionResult<{ executiveId: string }>>`. It requires `commissions.markPaid` (Owners). Names are unique, ignoring case.
  - `setClientCommission(clientId: string, input: { shares: { executiveId: string; ratePercent: number }[]; effectiveFrom: Date; monthsBeforePortal?: number }): Promise<ActionResult>`. It requires `commissions.markPaid`, converts percent to bp (`ratePercent × 100`, whole bp only), runs `validateSplit`, and requires every executive to be active. It inserts a new version, never updating old rows. It sets `commissionMonthsBeforePortal` when given, as an integer from 0 to 12. Then it calls `recomputeClient` and writes an audit entry `commission_split_set` with the before and after.
  - `unassignedClients(): Promise<{ id: string; name: string; status: ClientStatus }[]>`, for clients not ENDED that have no shares.
  - `ActionResult` is reused from `src/billing/discounts.ts`.

- [ ] **Step 1: Write the failing test** `splits.test.ts`, mocking the session the way `applyDiscount.test.ts` does:
  - **Owner:** sets Jose 5% + Albert 5% from 2026-11-01. Two share rows are written. A payment on 2026-11-15 that was recorded *before* the assignment now has 2 EARNED entries of 4000 each (Review Focus 1). Running `setClientCommission` again with the same split adds no duplicate entries.
  - **Split change mid-window:** a version from 2026-06-01 at Jose 10%, then one from 2026-11-01 at Albert 10%. The 2026-10 payment's entry is Jose's, and the 2026-11 payment's is Albert's (Review Focus 4).
  - **Rejected:** 6% + 5%, an unknown or inactive executive, and `ratePercent` 2.555 (not a whole bp) are all refused.
  - **Admin:** gets `"You don't have permission to do that."` and no rows are written.
  - **Unassigned:** `unassignedClients()` lists a client without shares and omits ENDED clients.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): executives and per-client commission splits`.

---

### Task 5: Statements, mark paid, progress

**Files:**
- Create: `portal/src/commissions/statements.ts`
- Test: `portal/tests/commissions/statements.test.ts`

**Interfaces:**
- Produces:
  - `listStatements(): Promise<{ executiveId: string; executiveName: string; month: string; totalCents: number; lineCount: number; status: "OPEN" | "PAID"; paidAt: Date | null }[]>`. There is one row per executive and month that has entries, newest first. A PAID row shows its frozen `totalCents`.
  - `statementLines(executiveId: string, month: string): Promise<{ clientName: string; invoiceId: string; kind: "EARNED" | "CLAWBACK"; occurredAt: Date; baseCents: number; rateBp: number; amountCents: number; windowIndex: number | null }[]>`
  - `markStatementPaid(executiveId: string, month: string, paidAt: Date): Promise<ActionResult>`. It requires `commissions.markPaid`, refuses the current or a future month (in the business timezone), refuses a statement that's already paid, freezes `totalCents` and writes an audit entry `commission_statement_paid`.
  - `commissionProgress(clientId: string): Promise<{ windowMonths: number; earnedMonths: number; remainingMonths: number; split: { executiveName: string; ratePercent: number }[] }>`

- [ ] **Step 1: Write the failing test** `statements.test.ts`:
  - Two payments for Jose in 2026-10 and one in 2026-11 produce statements `2026-11` (OPEN, 8000) and `2026-10` (OPEN, 16000), newest first.
  - Marking `2026-10` paid freezes its total at 16000. A later refund on an October invoice adds a −4000 CLAWBACK to the **next open month**. October's lines and its 16000 total are unchanged (Review Focus 2).
  - Paying the current month, paying it twice, or paying as an Admin is refused.
  - `commissionProgress` with `monthsBeforePortal 3` and 2 paid portal months gives `{ windowMonths: 12, earnedMonths: 5, remainingMonths: 7 }`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): commission statements and payouts`.

---

### Task 6: Commission screens and client setup form

**Files:**
- Create:
  - `portal/src/app/commissions/page.tsx`: executives, the add-executive form, the statements table with "Mark paid", and the unassigned clients list.
  - `portal/src/app/commissions/[executiveId]/[month]/page.tsx`: the lines plus a total.
  - `portal/src/app/commissions/actions.ts`: `"use server"` wrappers.
  - `portal/src/app/clients/[subscriptionId]/CommissionForm.tsx`
- Modify:
  - The client page: a Commission section for `commissions.view`, showing the split, earned/remaining months and the form.
  - `PortalHeader`: a "Commissions" link for `commissions.view`.
  - `scripts/e2e-smoke.cjs`: add checks.

**Interfaces:**
- Consumes everything from Task 4 and Task 5. Each page calls `requirePermission("commissions.view")` first.
- The form fields are: executive 1 and percent, optional executive 2 and percent, "effective from" (a date, default today) and "paid months already earned before the portal" (0–12, default 0).

- [ ] **Step 1:** Build the pages. Show money with `formatUsd`, months as "November 2026" and rates as "5%".
- [ ] **Step 2: Extend the smoke script.**
  - **Owner:** the Commissions link is visible, `/commissions` loads, and the client page shows "Commission".
  - **Admin:** there's no Commissions link, `/commissions` returns a forbidden or error page, not data, and the client page has no "Commission" section.
- [ ] **Step 3:** Run `npx tsc --noEmit && npx vitest run && npx next build`, then run the smoke script. Expected: all checks pass.
- [ ] **Step 4:** Commit: `feat(portal): commission screens`.

---

## Done when

- **Automated checks:** CI is green and the smoke test passes.
- **Owners can:**
  - add Jose and Albert as executives;
  - set a client's split (with the months already earned before the portal);
  - see commission appear when that client's payment clears;
  - see a refund come back off the next open statement;
  - mark a past month paid, with it then locked.
- **Admins can't** see any commission data.
