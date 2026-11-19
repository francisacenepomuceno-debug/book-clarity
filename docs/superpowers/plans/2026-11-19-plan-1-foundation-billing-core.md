# Plan 1: Foundation and Billing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable portal skeleton with role-based login, a database of packages, clients and payments kept in sync from Stripe webhooks, an automatic client status, the 3% credit-card fee on invoices, and Owner-applied discounts.

**Architecture:**
- **App:** a Next.js App Router app in `portal/`. Business rules are pure TypeScript functions in `portal/src/domain/` with no I/O, so they're unit-tested directly.
- **Database:** Prisma/Postgres holds the portal's own state.
- **Stripe:** webhooks land in one verified, idempotent route that hands each event to a handler in `portal/src/stripe/handlers/`.
- **Permissions:** checked on the server through a single `requirePermission()` guard.

**Tech Stack:**
- Node 22, Next.js 15 (App Router), TypeScript (strict)
- Prisma 6 + PostgreSQL 16
- Stripe Node SDK (latest), Auth.js v5 (email magic link), `otplib` for TOTP 2FA
- Vitest, Playwright (one smoke test)

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md`. Read sections 4–7 and 15 before starting.

## Global Constraints

- All money is stored as **integer cents, USD**. There are no floats anywhere in money math. Rounding is half-up to the cent, done once at the end of a calculation.
- Card fee: **3% maximum**. Charged **only when `card.funding === "credit"`**. Never charged on debit, prepaid or ACH (`us_bank_account`).
- Fee line description, verbatim: `Credit card processing fee (3%)`.
- The fee base is the invoice amount **after discounts**, excluding any existing fee line.
- Roles: `SUPER_ADMIN`, `OWNER`, `ADMIN`. Admins never receive revenue totals, amounts, discounts, commissions or settings, and this is enforced on the server.
- Owner and Super Admin accounts require TOTP 2FA.
- Every Stripe webhook verifies its signature and is idempotent by `event.id`.
- No migration of existing subscriptions. Nothing in this plan modifies a subscription except applying a discount that an Owner asked for.
- Secrets live only in environment variables (`.env.local`, never committed). Use Stripe **test mode** keys in dev and CI.
- The business timezone comes from setting `BUSINESS_TZ` (default `America/New_York`).

## Review Focus

1. **Duplicate or out-of-order webhooks.** A replayed `invoice.created` must not add a second fee line. An `invoice.paid` that arrives before `invoice.created` must not crash. (Task 4 and Task 5 tests.)
2. **Fee on an invoice that's already finalized.** Stripe only allows adding items to a `draft` invoice. A non-draft invoice must be skipped and logged, never throw. (Task 5 test.)
3. **A client with no default payment method**, or a card where `funding` is `unknown`. No fee is added. (Task 3 test.)
4. **An Admin calling an Owner-only server action directly** (bypassing the UI). It must get 403. (Task 2 test.)
5. **A discount that conflicts with an existing discount.** Applying a new discount replaces the old one in Stripe, and the audit log records both the replaced and the new discount. (Task 6 test.)

---

## File structure

```
portal/
  package.json, tsconfig.json, next.config.ts, vitest.config.ts, .env.example
  prisma/schema.prisma
  src/
    lib/db.ts                 Prisma client singleton
    lib/money.ts              cents helpers
    lib/env.ts                validated env (zod)
    auth/config.ts            Auth.js config
    auth/permissions.ts       role → permission map, requirePermission()
    auth/totp.ts              2FA enrol/verify
    domain/cardFee.ts         pure fee decision
    domain/clientStatus.ts    pure status derivation
    domain/discount.ts        pure discount validation → Stripe coupon params
    stripe/client.ts          Stripe SDK instance
    stripe/webhook.ts         verify + idempotency + dispatch
    stripe/handlers/*.ts      one file per event family
    audit/log.ts              writeAudit()
    app/api/stripe/webhook/route.ts
    app/(portal)/layout.tsx, app/(portal)/clients/page.tsx, app/(portal)/clients/[id]/page.tsx
    app/(portal)/clients/[id]/discount-action.ts
    app/login/page.tsx, app/login/2fa/page.tsx
  tests/
    domain/*.test.ts, auth/*.test.ts, stripe/*.test.ts, e2e/smoke.spec.ts
.github/workflows/portal-ci.yml
```

---

### Task 1: Scaffold, database schema, CI

**Files:**
- Create: everything under `portal/` listed above as config, plus `prisma/schema.prisma`, `src/lib/db.ts`, `src/lib/money.ts`, `src/lib/env.ts`
- Create: `.github/workflows/portal-ci.yml`
- Test: `tests/lib/money.test.ts`

**Interfaces:**
- Produces:
  - Prisma models (field names are binding for later plans):
    - `User { id, email @unique, name, role Role, totpSecret String?, totpEnabled Boolean @default(false) }`
    - `enum Role { SUPER_ADMIN OWNER ADMIN }`
    - `Package { id, name, stripePriceId @unique, monthlyPriceCents Int, onboardingFeeCents Int, isCustom Boolean, active Boolean }`
    - `Client { id, name, email, billingState String?, type ClientType, status ClientStatus, packageId?, stripeCustomerId @unique?, stripeSubscriptionId @unique?, ghlContactId?, defaultPaymentFunding String?, createdAt, endedAt? }`
    - `enum ClientType { DIRECT ACE }`
    - `enum ClientStatus { ONBOARDING PREPAID_ACE CURRENT UNPAID PAST_DUE AT_RISK CONTINUING_AWAITING_PM ENDED }`
    - `Invoice { id, stripeInvoiceId @unique, clientId?, status String, subtotalCents, discountCents, cardFeeCents, totalCents, amountPaidCents, paidAt DateTime?, paymentMethodType String?, cardFunding String?, firstFailedAt DateTime?, periodStart, periodEnd, kind InvoiceKind }`
    - `enum InvoiceKind { SUBSCRIPTION ONBOARDING ACE_BATCH OTHER }`
    - `Discount { id, clientId, kind DiscountKind, percentOff Int?, amountOffCents Int?, months Int, reason String, stripeCouponId, createdById, createdAt, replacedAt DateTime? }`
    - `enum DiscountKind { PERCENT AMOUNT }`
    - `StripeEvent { id String @id /* event.id */, type, receivedAt, processedAt DateTime? }`
    - `AuditLog { id, actorId String?, action String, entity String, entityId String, before Json?, after Json?, at DateTime @default(now()) }`
    - `Setting { key String @id, value Json }`
  - `money.ts`: `percentOfCents(cents: number, basisPoints: number): number` (half-up), `formatUsd(cents: number): string`.
  - `env.ts`: `env` object with `DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, AUTH_SECRET, BUSINESS_TZ`.

- [ ] **Step 1:** Scaffold the Next.js app in `portal/` (TypeScript, App Router, no Tailwind requirement). Add Prisma, Vitest, zod, stripe, next-auth@5, otplib. Add npm scripts `test`, `lint`, `typecheck`, `db:migrate`.
- [ ] **Step 2: Write the failing test** `tests/lib/money.test.ts`:
  ```ts
  expect(percentOfCents(80000, 300)).toBe(2400);   // $800 × 3% = $24.00
  expect(percentOfCents(33333, 300)).toBe(1000);   // 999.99 → half-up → 1000
  expect(percentOfCents(0, 300)).toBe(0);
  expect(formatUsd(123456)).toBe("$1,234.56");
  ```
- [ ] **Step 3:** Run `npm test -- money`. Expected: FAIL (module missing).
- [ ] **Step 4:** Implement `money.ts` with integer math: `Math.floor((cents * bp + 5000) / 10000)`. Write `schema.prisma` with the models above and run `npx prisma migrate dev --name init`.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6:** Add the CI workflow: a Postgres 16 service, then `npm ci && npx prisma migrate deploy && npm run typecheck && npm run lint && npm test`, all in `portal/`.
- [ ] **Step 7:** Commit: `feat(portal): scaffold app, schema and CI`.

---

### Task 2: Login, roles and server-side permissions

**Files:**
- Create: `src/auth/config.ts`, `src/auth/permissions.ts`, `src/auth/totp.ts`, `src/app/login/page.tsx`, `src/app/login/2fa/page.tsx`, `src/app/(portal)/layout.tsx`
- Test: `tests/auth/permissions.test.ts`, `tests/auth/totp.test.ts`

**Interfaces:**
- Produces:
  - `type Permission = "clients.view" | "clients.viewFinancials" | "payments.view" | "payments.viewAmounts" | "onboarding.view" | "reviews.view" | "discounts.apply" | "commissions.view" | "commissions.markPaid" | "ace.manage" | "reports.view" | "audit.view" | "settings.manage" | "users.manage"`
  - `can(role: Role, p: Permission): boolean`
  - `requirePermission(p: Permission): Promise<User>`. This throws a `ForbiddenError` (HTTP 403) when the signed-in user lacks the permission, and redirects to `/login` when nobody is signed in.
  - `verifyTotp(secret: string, token: string): boolean`
  - `generateTotpSecret(): { secret: string; otpauthUrl: string }`

- [ ] **Step 1: Write the failing test** `permissions.test.ts`:
  - Admins get `clients.view`, `payments.view`, `onboarding.view` and `reviews.view`, and **nothing else**. Assert every other permission is false for `ADMIN`.
  - Owners get everything **except** `settings.manage` and `users.manage`.
  - Super Admins get every permission.
  - `requirePermission("discounts.apply")` with a mocked `ADMIN` session rejects with `ForbiddenError`.
- [ ] **Step 2: Write the failing test** `totp.test.ts`: a token generated by `otplib.authenticator.generate(secret)` verifies true, and `"000000"` verifies false.
- [ ] **Step 3:** Run `npm test -- auth`. Expected: FAIL.
- [ ] **Step 4:** Implement the permission map as one `Record<Role, ReadonlySet<Permission>>`. Configure Auth.js with an email (magic-link) provider and a Prisma adapter, and only allow sign-in for emails that already exist in `User`. After sign-in, OWNER and SUPER_ADMIN users must pass `/login/2fa`, enrolling on first login. The session carries `twoFactorVerified`, and `requirePermission` treats an Owner or Super Admin session without it as not signed in.
- [ ] **Step 5:** Add a seed script `prisma/seed.ts` that creates the first SUPER_ADMIN from env `SEED_SUPER_ADMIN_EMAIL`.
- [ ] **Step 6:** Run `npm test`. Expected: PASS.
- [ ] **Step 7:** Commit: `feat(portal): role-based auth with 2FA for owners`.

---

### Task 3: Card-fee and client-status rules (pure domain)

**Files:**
- Create: `src/domain/cardFee.ts`, `src/domain/clientStatus.ts`
- Test: `tests/domain/cardFee.test.ts`, `tests/domain/clientStatus.test.ts`

**Interfaces:**
- Produces:
  - `type FeeSettings = { enabled: boolean; rateBasisPoints: number /* ≤ 300 */; excludedStates: string[] }`
  - `decideCardFee(i: { baseCents: number; paymentMethodType: "card" | "us_bank_account" | null; cardFunding: "credit" | "debit" | "prepaid" | "unknown" | null; billingState: string | null; settings: FeeSettings }): { feeCents: number; reason: "credit_card" | "not_credit" | "no_method" | "state_excluded" | "disabled" }`
  - `deriveClientStatus(i: { type: ClientType; endedAt: Date | null; onboardingComplete: boolean; acePrepaidUntil: Date | null; continuingAwaitingPm: boolean; latestInvoice: { status: "draft" | "open" | "paid" | "uncollectible" | "void"; firstFailedAt: Date | null } | null; now: Date }): ClientStatus`

- [ ] **Step 1: Write the failing test** `cardFee.test.ts`:
  ```ts
  const s = { enabled: true, rateBasisPoints: 300, excludedStates: ["CT"] };
  decideCardFee({ baseCents: 80000, paymentMethodType: "card", cardFunding: "credit", billingState: "TX", settings: s }) // → { feeCents: 2400, reason: "credit_card" }
  // cardFunding "debit"   → { feeCents: 0, reason: "not_credit" }
  // cardFunding "prepaid" → 0, "not_credit";  "unknown" → 0, "not_credit"
  // paymentMethodType "us_bank_account" → 0, "not_credit"
  // paymentMethodType null → 0, "no_method"
  // billingState "CT" with credit → 0, "state_excluded"
  // settings.enabled false → 0, "disabled"
  // rateBasisPoints 450 → throws RangeError (cap is 300)
  ```
- [ ] **Step 2: Write the failing test** `clientStatus.test.ts`. Write one case for each row of this precedence table, checked in this order:

  | Condition | Status |
  |---|---|
  | `endedAt` set | ENDED |
  | `!onboardingComplete` | ONBOARDING |
  | `acePrepaidUntil > now` | PREPAID_ACE |
  | `continuingAwaitingPm` | CONTINUING_AWAITING_PM |
  | invoice `open`, `firstFailedAt` set, 21 or more days ago | AT_RISK |
  | invoice `open`, `firstFailedAt` set | PAST_DUE |
  | invoice `open`, no failure | UNPAID |
  | invoice `paid`, or no invoice yet | CURRENT |

  Also test the boundaries: exactly 21 days → AT_RISK, and 20 days 23 hours → PAST_DUE. And test that an ACE client whose invoice is `open` and failed while `acePrepaidUntil > now` is still PREPAID_ACE. That last case is an anti-goal guard.
- [ ] **Step 3:** Run `npm test -- domain`. Expected: FAIL.
- [ ] **Step 4:** Implement both functions. Use `percentOfCents` from Task 1 for the fee. Neither function does any I/O.
- [ ] **Step 5:** Run `npm test -- domain`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(portal): card-fee and client-status rules`.

---

### Task 4: Stripe webhook intake and invoice/subscription sync

**Files:**
- Create: `src/stripe/client.ts`, `src/stripe/webhook.ts`, `src/stripe/handlers/invoice.ts`, `src/stripe/handlers/subscription.ts`, `src/stripe/handlers/paymentMethod.ts`, `src/app/api/stripe/webhook/route.ts`, `src/audit/log.ts`
- Test: `tests/stripe/webhook.test.ts`, `tests/stripe/invoiceSync.test.ts`

**Interfaces:**
- Consumes: `deriveClientStatus` (Task 3), Prisma models (Task 1).
- Produces:
  - `handleStripeEvent(event: Stripe.Event): Promise<"processed" | "duplicate" | "ignored">`. It inserts the `StripeEvent` row first. A unique-constraint violation on that insert returns `"duplicate"`.
  - `upsertInvoiceFromStripe(inv: Stripe.Invoice): Promise<Invoice>`. It works out `kind` from `inv.subscription` (SUBSCRIPTION) or the `metadata.kind` field.
  - `refreshClientStatus(clientId: string, now?: Date): Promise<ClientStatus>`
  - `writeAudit(e: { actorId: string | null; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }): Promise<void>`
  - Route `POST /api/stripe/webhook` verifies with `stripe.webhooks.constructEvent` and returns 400 on a bad signature. On success it returns 200 with `{ result }`.

- [ ] **Step 1: Write the failing test** `webhook.test.ts`:
  - Sending the same event object twice gives `"processed"` and then `"duplicate"`, and the handler side effect runs once (spy).
  - An unknown event type gives `"ignored"`, and a `StripeEvent` row is still stored.
  - The route returns 400 when the `stripe-signature` header is invalid.
- [ ] **Step 2: Write the failing test** `invoiceSync.test.ts`, using a test DB with fixture Stripe objects in `tests/fixtures/stripe/`:
  - `invoice.payment_failed` sets `firstFailedAt` (only if it's null) and moves the client to PAST_DUE.
  - `invoice.paid` sets `paidAt`, `amountPaidCents`, `paymentMethodType` and `cardFunding` (read from the expanded charge's `payment_method_details`), and moves the client to CURRENT.
  - `invoice.paid` for an invoice the DB has never seen (out of order) upserts it without error.
  - `customer.subscription.deleted` sets the client's `endedAt`.
  - `payment_method.attached`, or a customer `invoice_settings.default_payment_method` change, updates `Client.defaultPaymentFunding`.
- [ ] **Step 3:** Run `npm test -- stripe`. Expected: FAIL.
- [ ] **Step 4:** Implement it. The route reads the raw body (`await req.text()`). The handlers look up the client by `stripeCustomerId` and skip quietly, with a log line, when there's no match, because unknown customers are Plan 6's job. Use the Node runtime for the route.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Manual check.** Run `stripe listen --forward-to localhost:3000/api/stripe/webhook` and `stripe trigger invoice.payment_failed`. Expected: a 200 response in the CLI and a new `StripeEvent` row.
- [ ] **Step 7:** Commit: `feat(portal): verified idempotent Stripe webhook and invoice sync`.

---

### Task 5: Apply the 3% fee to draft invoices and refund mismatches

**Files:**
- Create: `src/stripe/handlers/cardFee.ts`
- Modify: `src/stripe/webhook.ts` (dispatch `invoice.created` → `applyCardFeeToDraft`; on `invoice.paid` also call `reconcileCardFee`)
- Test: `tests/stripe/cardFee.test.ts`

**Interfaces:**
- Consumes: `decideCardFee`, `percentOfCents`, `writeAudit`, `Setting` key `cardFee` (shape `FeeSettings`, default `{ enabled: false, rateBasisPoints: 300, excludedStates: [] }`). The fee starts **disabled** until the launch checklist (spec §14.3).
- Produces:
  - `applyCardFeeToDraft(inv: Stripe.Invoice, stripe: Stripe): Promise<"added" | "skipped_not_draft" | "skipped_exists" | "skipped_rule">`
  - `reconcileCardFee(inv: Stripe.Invoice, stripe: Stripe): Promise<"refunded" | "logged_uncollected" | "ok">`
  - The fee invoice item carries `metadata.bc_card_fee = "1"`, with description `Credit card processing fee (3%)`.

- [ ] **Step 1: Write the failing test** `cardFee.test.ts`, with the Stripe SDK mocked:
  - A draft invoice, a $800.00 subtotal after discount, and a default PM of credit card in TX: `invoiceItems.create` is called once with `amount: 2400`, `invoice: inv.id`, the fee description and the metadata. Result `"added"`.
  - The same invoice delivered again, now with a line that has `bc_card_fee=1`: result `"skipped_exists"` and no create call.
  - A non-draft invoice: `"skipped_not_draft"`, no create call, no throw.
  - A debit PM: `"skipped_rule"`.
  - Reconcile: a paid invoice with a fee line, paid by `us_bank_account`, gets `refunds.create({ charge, amount: 2400, metadata: { bc_card_fee_refund: "1" } })` and the result is `"refunded"`. Running it again when that refund already exists does nothing.
  - Reconcile: an invoice with no fee line paid by a credit card gives `"logged_uncollected"` and writes an audit row with action `card_fee_uncollected`.
- [ ] **Step 2:** Run `npm test -- cardFee`. Expected: FAIL.
- [ ] **Step 3:** Implement it. The base is `inv.subtotal - total_discount_amounts - any existing fee lines`. Get the default PM from the subscription's `default_payment_method`, falling back to the customer's `invoice_settings.default_payment_method`, then retrieve it for `card.funding`. Get `billingState` from the customer address. Only handle invoices with `billing_reason` of `subscription_cycle` or `subscription_create`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check (test mode).**
  - Make a test-clock subscription with card `4242 4242 4242 4242` (credit) and advance the clock. The finalized invoice shows the fee line.
  - Repeat with `4000 0566 5566 5556` (debit). There's no fee line.
- [ ] **Step 6:** Commit: `feat(portal): 3% credit-card fee on subscription invoices`.

---

### Task 6: Owner discounts

**Files:**
- Create: `src/domain/discount.ts`, `src/app/(portal)/clients/[id]/discount-action.ts`
- Test: `tests/domain/discount.test.ts`, `tests/stripe/applyDiscount.test.ts`

**Interfaces:**
- Consumes: `requirePermission("discounts.apply")`, `writeAudit`, Stripe client.
- Produces:
  - `validateDiscount(i: { kind: "PERCENT" | "AMOUNT"; percentOff?: number; amountOffCents?: number; months: number; reason: string; monthlyPriceCents: number }): { ok: true; coupon: Stripe.CouponCreateParams } | { ok: false; error: string }`
  - `applyDiscountAction(clientId: string, input: DiscountInput): Promise<{ ok: true; discountId: string } | { ok: false; error: string }>`, a server action.
  - `applyRetroactiveDiscountAction(invoiceId: string, input: { amountCents: number; reason: string }): Promise<...>`. It issues a partial refund with `metadata.bc_retro_discount="1"`. Commission clawback for it is in Plan 2.

- [ ] **Step 1: Write the failing test** `discount.test.ts`:
  - PERCENT 20, 3 months gives `{ percent_off: 20, duration: "repeating", duration_in_months: 3 }`.
  - AMOUNT 15000 cents, 2 months gives `{ amount_off: 15000, currency: "usd", duration: "repeating", duration_in_months: 2 }`.
  - Each of these is rejected: percent 0, percent above 100, an amount above `monthlyPriceCents`, months below 1, and an empty or whitespace reason.
  - PERCENT 100 is allowed. (Q3: these $0 months are handled in Plan 2.)
- [ ] **Step 2: Write the failing test** `applyDiscount.test.ts`, with Stripe mocked and a test DB:
  - **Owner:** creates the coupon, then calls `subscriptions.update(subId, { discounts: [{ coupon }] })`. A `Discount` row and an `AuditLog` row (`action: "discount_applied"`) are written.
  - **The client already has an active discount:** the old row gets `replacedAt`, and the audit `before` holds the old discount (Review Focus 5).
  - **Admin session:** returns 403 and makes no Stripe calls.
  - **Retroactive:** a refund is created for the exact amount on the invoice's charge, and the amount can't exceed `amountPaidCents`.
- [ ] **Step 3:** Run `npm test -- discount`. Expected: FAIL.
- [ ] **Step 4:** Implement it. Name coupons `BC-<clientId>-<timestamp>` and set `metadata.reason`.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(portal): owner-applied discounts with audit trail`.

---

### Task 7: Minimal Clients screens (role-scoped) and smoke test

**Files:**
- Create: `src/app/(portal)/clients/page.tsx`, `src/app/(portal)/clients/[id]/page.tsx`, `src/app/(portal)/clients/queries.ts`
- Test: `tests/clients/queries.test.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `requirePermission`, `can`, Prisma.
- Produces:
  - `listClients(viewer: User): Promise<ClientRow[]>`. The type is `ClientRow = { id, name, status, type, packageName, nextChargeDate }`, plus `{ monthlyPriceCents, discountSummary, paymentMethod }` **only** when `can(viewer.role, "clients.viewFinancials")`.
  - The fields are filtered at the query layer, not in the UI.

- [ ] **Step 1: Write the failing test** `queries.test.ts`:
  - For an ADMIN viewer, every row has **no** `monthlyPriceCents`, `discountSummary` or `paymentMethod` key at all (`expect(row).not.toHaveProperty(...)`).
  - For an OWNER viewer, the rows have those keys.
- [ ] **Step 2:** Run `npm test -- queries`. Expected: FAIL.
- [ ] **Step 3:** Implement the query and two plain server-rendered pages:
  - **List page:** status badge, type, package and next charge.
  - **Detail page:** invoice history and, for Owners only, the discount form wired to `applyDiscountAction`.
- [ ] **Step 4: Write the smoke test** `smoke.spec.ts`: log in with a seeded owner (a test-only auth bypass that's enabled only when `NODE_ENV=test`), open `/clients`, and see the seeded client's name and status.
- [ ] **Step 5:** Run `npm test && npx playwright test --trace off`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(portal): role-scoped clients list and detail`.

---

## Done when

- CI is green: typecheck, lint, unit and integration tests.
- In Stripe test mode:
  - a credit-card renewal gets the 3% line and a debit renewal doesn't;
  - a failed payment moves the client to Past due;
  - an Owner can apply a 3-month 20% discount and see it in Stripe and in the audit log;
  - an Admin can't see amounts or apply discounts, even by calling the action directly.
