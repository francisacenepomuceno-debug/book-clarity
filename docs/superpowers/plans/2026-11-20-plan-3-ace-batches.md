# Plan 3: ACE Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners can record ACE's bulk purchases, invoice ACE through Stripe or record a check or bank-transfer payment, and put ACE clients into prepaid slots. Those clients are never billed or reminded during their 6 months, and executives earn the ACE commission. Around month 6, each client is either moved onto their own autopay or ended.

**Architecture:**
- **Data:** new `AceBatch` / `AceBatchLine` / `AceSlot` tables plus a `Package` price list. Pure date and money rules live in `src/domain/ace.ts`. Services live in `src/ace/`.
- **Commission:** the months 1–6 lump sum is a new ledger kind (`ACE_PREPAID`) keyed by slot. It is written when the slot is filled **and** the batch is paid, whichever happens last, so it is pending until both are true.
- **Continuing clients:** a Stripe Checkout *setup* session collects the payment method. On `checkout.session.completed` the subscription is created, and its first charge is the day after the prepaid period ends.

**Tech Stack:** Same as Plans 1–2.

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md`. Read §7.4, the ACE rows of §9, §18 (D2, D6) and §19 (Q1).

## Global Constraints

- A slot is **6 months of service + onboarding**. The 6 months start on the **client's onboarding date**, which is the slot's `startDate`. `prepaidUntil = startDate + 6 calendar months − 1 day`, as an end-of-day date in `BUSINESS_TZ`.
- **During the prepaid period**, the status is `PREPAID_ACE`. The client is never billed or reminded, and never shows as past due (spec anti-goal).
- **The batch invoice goes to ACE.** ACE pays by ACH with no fee, or by credit card with the 3% fee as its own line (reuse `decideCardFee`). It is paid out-of-band for a check or transfer through "Record payment received" (method, date, reference), which uses `invoices.pay({ paid_out_of_band: true })`.
- **ACE commission, months 1–6:** a lump sum of `6 × the package's monthly list price` (Q1). A Custom slot uses its own Custom price. It goes to the client's split at the slot `startDate`. It posts on the later of the slot start and the batch-paid date, and it is **pending** (not in the ledger) while the batch is unpaid. It is never clawed back if the client leaves early. The onboarding fee is never commissioned.
- **ACE commission, months 7–12:** the next 6 paid subscription invoices. This already works in Plan 2 through `windowMonthsFor({ type: "ACE" }) = 6`.
- **Continuation:**
  - The client is flagged **30 days** before `prepaidUntil`.
  - **Continuing:** status `CONTINUING_AWAITING_PM` until a payment method is saved. Then a subscription on the slot's package price starts, with the first charge on `prepaidUntil + 1 day`. There is no onboarding fee.
  - **Not continuing, or no answer:** an Owner marks the client Ended. The portal never ends a client on its own (spec §7.4 and D6).
- **Historical batches (D2):** the same create form accepts a past purchase date and "already paid outside the portal", which creates no Stripe invoice.
- **Who can do what:** `ace.manage` (Owners, Super Admin) for everything here. Admins see only the client status ("Prepaid by ACE").
- Money is integer cents.

## Review Focus

1. **A batch that's still unpaid has a slot filled.** That commission is pending, then posts exactly once when the batch is paid, by Stripe or recorded by hand. Covered by a Task 3 test.
2. **More clients are assigned than the batch has slots of that package.** The assignment is refused. Two Owners assigning the last slot at the same time results in one success. Covered by a Task 3 test.
3. **An ACE client's own Stripe invoice is open or failed during the prepaid period** (for example a stray invoice). The status stays `PREPAID_ACE`. Covered by a Task 3 test.
4. **The setup link is completed twice, or the webhook arrives twice.** Only one subscription is created. Covered by a Task 4 test.
5. **A slot that starts on the 31st** (Jan 31 + 6 months) ends on a real date, Jul 30, not an invalid one. Covered by a Task 1 test.

---

## File structure

```
prisma/schema.prisma                + AcePayment enum, AceBatch, AceBatchLine, AceSlot; Package.stripePriceId optional;
                                      Client.acePrepaidUntil, Client.aceSlotId, Client.continuationDecision; CommissionKind.ACE_PREPAID
src/domain/ace.ts                   pure: prepaidUntil, continuationDueAt, batchTotals, aceLumpBase
src/packages/packages.ts            list/upsert packages (price list)
src/ace/batches.ts                  createBatch, recordBatchPayment, onBatchInvoicePaid, listBatches, batchDetail
src/ace/slots.ts                    assignSlot, postAceCommission
src/ace/continuation.ts             dueForContinuation, markContinuing, markEnded, onSetupCompleted
src/stripe/clientStatusSync.ts      use acePrepaidUntil + continuation
src/stripe/webhook.ts               invoice.paid (ACE_BATCH) and checkout.session.completed routing
src/app/ace/...                     screens; src/app/settings/packages/...
```

---

### Task 1: Price list, schema and pure ACE rules

**Files:**
- Modify: `prisma/schema.prisma`, `tests/helpers/db.ts`
- Create: `src/domain/ace.ts`, `src/packages/packages.ts`
- Test: `tests/domain/ace.test.ts`, `tests/packages/packages.test.ts`

**Interfaces:**
- **Schema:**
  - `Package.stripePriceId String? @unique`. A package can exist before it's linked to a Stripe price.
  - `enum AcePayment { STRIPE OUT_OF_BAND }`
  - `AceBatch { id, purchasedAt DateTime, note String?, totalCents Int, stripeInvoiceId String? @unique, paidAt DateTime?, paymentMethod String?, paymentReference String?, createdById, createdAt }`
  - `AceBatchLine { id, batchId, packageId, quantity Int, unitPriceCents Int }`. `unitPriceCents` is what ACE pays per slot (6 months + onboarding).
  - `AceSlot { id, batchId, packageId, clientId String? @unique, startDate DateTime?, prepaidUntil DateTime?, customMonthlyCents Int? }`. Slots are created up front, one row per unit of quantity.
  - `Client.acePrepaidUntil DateTime?`, `Client.aceSlotId String?`, and `Client.continuationDecision String?` (`"CONTINUING"` | `"ENDING"` | null).
  - `CommissionKind` gains `ACE_PREPAID`.
- **`domain/ace.ts`:**
  - `prepaidUntil(startDay: string /* YYYY-MM-DD */, tz: string): Date`. Returns the last instant of the day before the same day-of-month 6 months later. If that day doesn't exist, it uses the last day of that month.
  - `continuationDueAt(prepaidUntil: Date): Date`, which is `prepaidUntil − 30 days`.
  - `batchTotals(lines: { quantity: number; unitPriceCents: number }[]): number`
  - `aceLumpBase(i: { monthlyListCents: number }): number`, which is `6 × monthlyListCents`.
- **`packages/packages.ts`:**
  - `listPackages(): Promise<Package[]>`
  - `savePackage(i: { id?: string; name: string; monthlyPriceCents: number; onboardingFeeCents: number; isCustom: boolean; stripePriceId?: string | null }): Promise<ActionResult<{ packageId: string }>>`. Requires `ace.manage`. The name and prices must be > 0, except a Custom package, whose price may be 0 because it's set per slot.

- [ ] **Step 1: Write the failing tests**
  - `prepaidUntil("2026-01-15", NY)` is the end of 2026-07-14 in New York, i.e. `toISOString()` `"2026-07-15T03:59:59.999Z"`.
  - `prepaidUntil("2026-01-31", NY)` is the end of 2026-07-30 (Review Focus 5).
  - `prepaidUntil("2026-08-31", NY)` is the end of 2027-02-27 (Feb has no 31st, so the period ends Feb 28 minus 1 day).
  - `continuationDueAt` gives the date 30 days earlier.
  - `batchTotals([{ quantity: 10, unitPriceCents: 260000 }, { quantity: 1, unitPriceCents: 500000 }])` is `3100000`.
  - `aceLumpBase({ monthlyListCents: 65000 })` is `390000`.
  - **Packages:** an Owner saves "Growth" at $650 with a $500 onboarding fee, and it lists. Saving again by `id` updates it. An Admin is refused. A non-Custom package at $0 is refused.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it, run `npx prisma migrate dev --name ace`, wait 3 seconds, and extend the TRUNCATE list.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): package price list, ACE schema and date rules`.

---

### Task 2: Batches, ACE invoice and payments

**Files:**
- Create: `src/ace/batches.ts`
- Modify: `src/stripe/webhook.ts` (route `invoice.paid` with `metadata.kind === "ACE_BATCH"` to `onBatchInvoicePaid`), `src/stripe/deps.ts`
- Test: `tests/ace/batches.test.ts`

**Interfaces:**
- `createBatch(i: { purchasedOn: string; lines: { packageId: string; quantity: number; unitPriceCents: number }[]; note?: string; alreadyPaid?: { paidOn: string; method: "check" | "bank_transfer" | "ach" | "card"; reference: string } }): Promise<ActionResult<{ batchId: string }>>`
  - It requires `ace.manage`. Every quantity must be ≥ 1 and every unit price > 0.
  - It creates the slots, one per unit.
  - **Without `alreadyPaid`:** it creates a Stripe invoice to the ACE customer, using setting `aceCustomerId` (Setting key `"ace"`, value `{ stripeCustomerId: string }`). It has one invoice item per line, with description `"<Package> — 6 months + onboarding (ACE)"`, `metadata { kind: "ACE_BATCH", batchId }`, `collection_method: "send_invoice"`, `days_until_due: 14`, and ACH and card allowed. The idempotency key is `bc-ace-batch-${batchId}`.
  - **With `alreadyPaid`:** there's no Stripe call, and `paidAt` is set.
  - If there's no ACE customer configured and the batch isn't already paid, it returns the error "Set ACE's Stripe customer in Settings first."
- `setAceCustomer(stripeCustomerId: string): Promise<ActionResult>`. Requires `ace.manage`. It checks the customer with `customers.retrieve`.
- `recordBatchPayment(batchId: string, i: { paidOn: string; method: string; reference: string }): Promise<ActionResult>`. It marks the Stripe invoice paid out of band (if there is one), with idempotency key `bc-ace-oob-${batchId}`. It sets `paidAt`, the method and the reference, writes an audit entry, then runs `postAceCommissionsForBatch(batchId)` from Task 3, which is a no-op stub in this task. It refuses a batch that's already paid.
- `onBatchInvoicePaid(inv: Stripe.Invoice): Promise<void>`. It finds the batch by `metadata.batchId`, sets `paidAt` from `status_transitions.paid_at` (only if it isn't set yet) and the method from the charge, then posts commissions.
- `listBatches()` and `batchDetail(batchId)` return each batch's lines, slot counts (used/open per package), paid state and total.

- [ ] **Step 1: Write the failing test** `batches.test.ts`, with a fake Stripe:
  - **Stripe invoice:** creating a batch of 10 Essentials at $2,600 plus 1 Custom at $5,000 creates 11 slots and calls `invoices.create` and `invoiceItems.create` twice. The invoice metadata is `{ kind: "ACE_BATCH", batchId }`, then `sendInvoice` is called. The total is `3100000`.
  - **Historical:** `alreadyPaid` makes no Stripe calls and sets `paidAt`.
  - **Recording a payment:** it calls `invoices.pay(id, { paid_out_of_band: true }, { idempotencyKey })`, and a second call is refused.
  - **Paid by Stripe:** `invoice.paid` with `metadata.kind = "ACE_BATCH"`, delivered through `handleStripeEvent`, sets `paidAt`. Delivered twice, it changes nothing.
  - **Refused:** an Admin, a quantity of 0, and a missing ACE customer.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): ACE batches, invoice and payments`.

---

### Task 3: Assign clients to slots, prepaid status, ACE commission

**Files:**
- Create: `src/ace/slots.ts`
- Modify: `src/stripe/clientStatusSync.ts` (pass `acePrepaidUntil` and `continuingAwaitingPm = continuationDecision === "CONTINUING" && !stripeSubscriptionId`), `src/commissions/statements.ts` (an `ACE_PREPAID` line shows as "ACE months 1–6"), `src/ace/batches.ts` (call the real `postAceCommissionsForBatch`)
- Test: `tests/ace/slots.test.ts`

**Interfaces:**
- `assignSlot(i: { batchId: string; packageId: string; clientId: string; startOn: string; customMonthlyCents?: number }): Promise<ActionResult<{ slotId: string }>>`
  - It requires `ace.manage` and takes the open slot of that package, `FOR UPDATE SKIP LOCKED` on a `clientId IS NULL` slot.
  - It refuses if no slot is open (Review Focus 2), if the client already has a slot, or if a Custom package has no `customMonthlyCents`.
  - It sets the slot (`clientId`, `startDate`, `prepaidUntil`) and the client (`type: ACE`, `acePrepaidUntil`, `aceSlotId`, `packageId`), then runs `refreshClientStatus`, writes an audit entry and calls `postAceCommission(slotId)`.
- `postAceCommission(slotId: string): Promise<number>`
  - It does nothing unless the slot has a client and the batch is paid.
  - The base is `aceLumpBase(custom ?? package.monthlyPriceCents)` and the split is `splitAt(shares, startDate)`.
  - It writes one `ACE_PREPAID` entry per executive with `invoiceId = "ace-slot:" + slotId`, `occurredAt = max(startDate, batch.paidAt)`, posted through `postingMonthFor`, with `skipDuplicates`.
- `postAceCommissionsForBatch(batchId: string): Promise<number>`
- **`setClientCommission`** (Plan 2) also calls `postAceCommission` for the client's slot, so assigning an owner later picks up the lump sum.

- [ ] **Step 1: Write the failing test** `slots.test.ts`:
  - **Paid batch:** assigning a client gives status `PREPAID_ACE`, `acePrepaidUntil` = `prepaidUntil(startOn)` and one `ACE_PREPAID` entry for Jose at 10% of `6 × 65000` = `39000`.
  - **Unpaid batch:** assigning creates no entry (pending). `recordBatchPayment` then creates it, once. Running `postAceCommissionsForBatch` again adds nothing (Review Focus 1).
  - **Last slot:** assigning a second client when there's only 1 Growth slot is refused. Two concurrent assignments for the last slot give exactly one `ok` (Review Focus 2).
  - **Stray invoice:** an ACE client with an open, failed SUBSCRIPTION invoice dated inside the prepaid period still has status `PREPAID_ACE` (Review Focus 3).
  - **Custom:** a Custom slot uses `customMonthlyCents` for the base, and refuses when it's missing.
  - **Owner assigned later:** with no split at assignment there's no entry. `setClientCommission` later creates the `ACE_PREPAID` entry.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): ACE slots, prepaid status and ACE commission`.

---

### Task 4: Month-6 continuation

**Files:**
- Create: `src/ace/continuation.ts`
- Modify: `src/stripe/webhook.ts` and `deps.ts` (handle `checkout.session.completed` with `metadata.kind === "ACE_CONTINUATION"`)
- Test: `tests/ace/continuation.test.ts`

**Interfaces:**
- `dueForContinuation(now?: Date): Promise<{ clientId: string; name: string; prepaidUntil: Date; decision: string | null }[]>`. It lists ACE clients with `acePrepaidUntil` within 30 days (or already past), not ENDED, and no subscription yet.
- `markContinuing(clientId: string, baseUrl: string): Promise<ActionResult<{ setupUrl: string }>>`. It requires `ace.manage` and sets `continuationDecision = "CONTINUING"`. It creates a Stripe Checkout session with `mode: "setup"`, the customer (creating one from the client's name and email if needed), `payment_method_types: ["card", "us_bank_account"]`, `metadata { kind: "ACE_CONTINUATION", clientId }`, and the success and cancel URLs at `baseUrl`. It returns the URL for the Owner to send. The status becomes `CONTINUING_AWAITING_PM` once the prepaid period is over (before that it stays `PREPAID_ACE`).
- `markEnded(clientId: string): Promise<ActionResult>`. It sets `continuationDecision = "ENDING"`, sets `endedAt` to `acePrepaidUntil` (or now if that's already past), and writes an audit entry.
- `onSetupCompleted(session: Stripe.Checkout.Session, stripe: Stripe): Promise<void>`. It does nothing if the client already has `stripeSubscriptionId` (Review Focus 4). Otherwise it:
  - sets the session's payment method as the customer's default;
  - creates a subscription on the package's `stripePriceId` (or a price made from `customMonthlyCents` for Custom), with `trial_end = prepaidUntil + 1 second` (the first charge falls on the day after), `metadata { kind: "ACE_CONTINUATION", clientId }` and idempotency key `bc-ace-sub-${clientId}`;
  - stores the subscription id and refreshes the status.
- If the package has no `stripePriceId` and isn't Custom, `markContinuing` refuses with "Link this package to a Stripe price in Settings → Packages."

- [ ] **Step 1: Write the failing test** `continuation.test.ts`, with a fake Stripe:
  - **The due list:** a client whose `prepaidUntil` is 20 days away is listed. One 60 days away isn't.
  - **Continuing:** `markContinuing` returns the URL, and the session metadata is right. An Admin is refused.
  - **Setup completed:** `onSetupCompleted` creates the subscription with the correct `trial_end` and the package price. Running it twice creates it only once.
  - **Custom package:** it uses `price_data` with `customMonthlyCents`.
  - **Ended:** `markEnded` sets the status to ENDED with `endedAt` = `prepaidUntil`.
  - **Status:** after `prepaidUntil` passes with CONTINUING and no subscription, the status is `CONTINUING_AWAITING_PM`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(portal): ACE month-6 continuation`.

---

### Task 5: Screens

**Files:**
- Create:
  - `src/app/settings/packages/page.tsx`: the price list (Owner and Super Admin), including the ACE Stripe customer setting.
  - `src/app/ace/page.tsx`: the batch list with slots used/open, paid state, a "New batch" form and the "Coming up on month 6" list with Continue / End buttons.
  - `src/app/ace/[batchId]/page.tsx`: lines, slots (client, start, prepaid until), the "Assign a client" form (pick a client and package, start date, Custom monthly price) and "Record payment received".
  - `src/app/ace/actions.ts` and `src/app/ace/Forms.tsx`.
- Modify:
  - Header links: "ACE" and "Packages" for `ace.manage`.
  - Client page: an ACE line showing the batch, prepaid until and decision.
  - The statement page: a slot line shows "ACE months 1–6" instead of "N of 12". This fixes the Plan 2 minor about the window label (use the line's kind; EARNED lines show `windowIndex of windowMonths`).
  - The dashboard: count `PREPAID_ACE` in a KPI and add a filter.
- Modify: `scripts/e2e-smoke.cjs`.

- [ ] **Step 1:** Build the pages using the existing `inline-form` / `panel` / `kpi` styles. After `markContinuing`, show the setup link in a copy box with the text "Send this link to the client to set up autopay."
- [ ] **Step 2: Extend the smoke script.**
  - **Owner:**
    - save a "Smoke Growth" package;
    - create an *already paid* historical batch with 1 slot (no Stripe write);
    - assign the first client, then see "Prepaid by ACE" on their page and an "ACE months 1–6" line on the Commissions statement.
  - **Admin:** no ACE or Packages links, and `/ace` shows "This page isn't available".
- [ ] **Step 3:** Run `npx tsc --noEmit && npx vitest run && npx next build`, then the smoke script. Expected: all pass.
- [ ] **Step 4:** Commit: `feat(portal): ACE and package screens`.

---

## Done when

- **Automated checks:** CI is green and the smoke test passes.
- **Owners can:**
  - keep a package price list;
  - record an ACE batch, either invoiced through Stripe or already paid;
  - record check or transfer payments;
  - fill slots with clients, who show as "Prepaid by ACE" and are never treated as past due;
  - see the ACE commission post once the batch is paid;
  - continue a client at month 6 with a setup link that starts their autopay the day after, or end them.
- **Admins** see only the status.
