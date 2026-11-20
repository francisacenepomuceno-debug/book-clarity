# Plan 4A: GHL Messaging and Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every client-facing notice goes out through Book Clarity's GHL (email and SMS), on the schedule in the spec. That covers payment reminders, Owner alerts, ACE month-6 notices with a client Yes/No page, and unpaid-batch reminders to ACE. Each message is sent once, logged, and skipped cleanly when GHL isn't configured yet.

**Architecture:**
- **The GHL client** (`src/ghl/`) calls API v2 with a Private Integration token: upsert contact, send message.
- **Message copy** is pure template functions (`src/notify/templates.ts`).
- **`sendNotice()`** sends each message once (unique key) and writes a `Notification` row.
- **Triggers:**
  - Stripe webhooks for immediate events: `invoice.upcoming` and `invoice.payment_failed` day 0.
  - A daily cron route (`/api/cron/daily`, run by Vercel Cron) for everything date-based.

**Tech Stack:** Same as before, plus `vercel.json` crons.

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md` §8, §7.4, §18 D6, §19 (Q2 and the 2026-11-20 owner answers).

## Global Constraints

- **GHL:** API base `https://services.leadconnectorhq.com`, headers `Authorization: Bearer ${GHL_API_TOKEN}`, `Version: 2021-07-28`.
  - The location comes from `GHL_LOCATION_ID`.
  - It must be **Book Clarity's own GHL**; the connected "Delegate to Elevate" account must never be used.
  - With no token, notices are logged `SKIPPED` ("GHL not configured") and **never throw**.
- **Each notice is sent at most once per key** (`Notification.key` is unique), even across webhook retries and repeated cron runs.
- **ACE-prepaid clients never get payment reminders.** That means status `PREPAID_ACE`, or `acePrepaidUntil` in the future.
- **Ended clients get no reminders.**
- **Schedule (spec §8):**

  | When | Notice |
  |---|---|
  | 3 days before each charge | Upcoming payment, via Stripe `invoice.upcoming` |
  | Decline, day 0 | Failed-payment notice with an update link |
  | Days 3, 7, 14 | Follow-up reminders |
  | Day 21 | Owner alert (At risk) |
  | Paid | Reminders stop at once |

- **ACE month-6 notices (owner, 2026-11-20):**
  - Sent at **60 days** before `prepaidUntil`, then at **30 and 14 days** while there's no Yes.
  - The client's link (`/continue/<token>`) shows **Yes, continue** and **No**:
    - **Yes** sets `continuationDecision = "CONTINUING"` and goes to the existing Stripe setup.
    - **No** sets `clientAnswer = "NO"` only. Nothing ends.
  - The link works until `prepaidUntil` unless an Owner has confirmed ending (`continuationDecision = "ENDING"`). After that date it works only if the decision is CONTINUING.
  - Owners can still mark the client continuing or confirm the end at any time.
  - Owner alert: when `prepaidUntil` passes with no subscription and no ENDING decision.
- **ACE batch unpaid:** a reminder to **ACE's billing contact** (setting `ace.contactEmail`) **7 and 14 days** after the invoice was sent, with the payment link (`/pay/ace/<token>`).
- **Update-payment link:** `/pay/update/<signed clientId>`. It opens a fresh Stripe Billing Portal session (payment method update) for that client's customer. It never expires and is revoked when the client ends.
- **Cron:** `GET /api/cron/daily` requires `Authorization: Bearer ${CRON_SECRET}`. `vercel.json` schedules it at `0 13 * * *`, which is 8–9am in New York.
- **Copy:** plain, warm, short. Always signed "Book Clarity". Never shows card numbers or full amounts in SMS beyond the amount due.

## Review Focus

1. **A webhook retry or a second cron run on the same day sends nothing twice.** Covered by a Task 2 test.
2. **A client pays mid-sequence.** No further failed-payment reminders go out. Covered by a Task 4 test.
3. **An ACE client answers No and then later Yes before the end.** The setup works, and the Owner sees both answers in the audit log. Covered by a Task 5 test.
4. **GHL isn't configured, or GHL returns 500.** The webhook and cron still succeed, and the notice is logged SKIPPED or FAILED. A FAILED notice is retried on the next cron run, and only once. Covered by a Task 2 test.
5. **A client with no email but a phone, or neither.** SMS only, or SKIPPED "no contact details". Covered by a Task 2 test.

---

### Task 1: GHL client and contact sync

**Files:** Create `src/ghl/client.ts`. Modify the schema (`Client.phone String?`). Test `tests/ghl/client.test.ts`.

**Interfaces:**
- `ghlConfigured(): boolean`
- `ghlUpsertContact(i: { email?: string | null; phone?: string | null; name: string }, f?: typeof fetch): Promise<string>`. This is `POST /contacts/upsert` with `{ locationId, email, phone, name }` and returns `contact.id`.
- `ghlSendMessage(i: { contactId: string; type: "Email" | "SMS"; subject?: string; html?: string; message?: string }, f?: typeof fetch): Promise<string>`. This is `POST /conversations/messages` and returns `messageId`.
- `class GhlError extends Error { status: number }`. It's thrown for HTTP status ≥ 400.

- [ ] **Step 1:** Write tests with a fake `fetch`. Assert the exact URL and headers (Bearer, `Version 2021-07-28`), the body includes `locationId`, the ids are parsed, and a 422 throws `GhlError` with status 422.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it and run the migration.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 2: `sendNotice` — once per key, logged, never throws

**Files:** Create `src/notify/send.ts`. Modify the schema (`Notification` model). Test `tests/notify/send.test.ts`.

**Interfaces:**
- `Notification { id, key String @unique, kind String, clientId String?, to String?, channels String /* "email,sms" */, status String /* SENT|SKIPPED|FAILED */, error String?, attempts Int @default(0), createdAt, sentAt DateTime? }`
- `sendNotice(i: { key: string; kind: string; clientId?: string; to: { name: string; email?: string | null; phone?: string | null; ghlContactId?: string | null }; email?: { subject: string; html: string }; sms?: string }): Promise<"SENT" | "SKIPPED" | "FAILED" | "DUPLICATE">`
  - It returns `DUPLICATE` if a row with the key is already SENT or SKIPPED, or is FAILED with `attempts ≥ 2`.
  - It saves the `ghlContactId` it creates on the client.

- [ ] **Step 1:** Write tests with `@/ghl/client` mocked:
  - **Sent once:** sent, then the same key gives DUPLICATE (Review Focus 1).
  - **Not configured:** SKIPPED, and nothing is sent.
  - **GHL returns 500:** FAILED. The next call retries, and the call after that gives DUPLICATE (Review Focus 4).
  - **Phone but no email:** SMS only.
  - **Neither:** SKIPPED "no contact details" (Review Focus 5).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it and run the migration.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 3: Message copy and the update-payment link

**Files:** Create `src/notify/templates.ts` and `src/app/pay/update/[token]/route.ts`. Modify `middleware` (`/pay/` is already public). Test `tests/notify/templates.test.ts`.

**Interfaces:**
- `templates.upcomingCharge({ name, amount, date, updateUrl })`
- `templates.paymentFailed({ name, amount, day: 0 | 3 | 7 | 14, updateUrl })`
- `templates.ownerAtRisk({ clientName, amount, since, clientUrl })`
- `templates.aceProgramEnding({ name, endDate, daysLeft, continueUrl })`
- `templates.ownerAceNoDecision({ clientName, endDate, clientUrl })`
- `templates.aceBatchUnpaid({ amount, sentOn, payUrl })`

Each returns `{ subject, html, sms }`.

- `updatePaymentLink(clientId, baseUrl): string`
- `startPaymentUpdate(token, baseUrl): Promise<{ url } | { error }>`. It uses `billingPortal.sessions.create({ customer, return_url, flow_data: { type: "payment_method_update" } })`.

- [ ] **Step 1:** Write tests:
  - Each template mentions the client's name and the link, and SMS is ≤ 320 characters.
  - The day-0 subject is "Your Book Clarity payment didn't go through".
  - The ACE notice states the end date and both choices.
  - `startPaymentUpdate`: a valid token gives the portal URL, and a tampered token or an ended client gives an error.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 4: Payment reminders (webhooks and daily cron)

**Files:** Create `src/notify/payments.ts`, `src/app/api/cron/daily/route.ts` and `vercel.json`. Modify `webhook.ts` and `deps.ts` (`invoice.upcoming`, and the `payment_failed` hook). Test `tests/notify/payments.test.ts`.

**Interfaces:**
- `onUpcomingInvoice(inv)`: key `upcoming:${sub}:${period_end}`.
- `onPaymentFailed(invoiceRowId)`: day 0, key `failed:${invoiceRowId}:0`.
- `runPaymentReminders(now)`: for open invoices with `firstFailedAt`:
  - days 3, 7 and 14 send to the client;
  - day 21 sends an Owner alert to every OWNER and SUPER_ADMIN user.

  It skips paid, ended and ACE-prepaid clients, and returns counts.
- `runDaily(now)`: runs payment reminders, ACE notices (Task 5) and batch reminders (Task 5).
- The cron route checks the bearer secret (401 otherwise) and returns the JSON counts.

- [ ] **Step 1:** Write tests:
  - Day 0 is sent once.
  - The day-3 run sends day 3 only, and re-running sends nothing.
  - After the invoice becomes paid, nothing more is sent (Review Focus 2).
  - An ACE-prepaid client gets nothing.
  - Day 21 alerts the owners.
  - The cron route returns 401 without the secret.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 5: ACE month-6 notices with the client Yes/No page, and batch reminders

**Files:**
- Modify the schema (`Client.clientAnswer String?`, `Client.clientAnsweredAt DateTime?`), `domain/ace.ts` (notice window 60), `ace/continuation.ts` (Yes/No and the link rules), the `/continue/[token]` route (it becomes a page with two buttons) and the `/ace` month-6 list (shows the client's answer and "Confirm end").
- Create `src/notify/ace.ts`.
- Test `tests/notify/ace.test.ts`.

**Interfaces:**
- `answerContinuation(token, answer: "YES" | "NO", baseUrl): Promise<{ url?: string; message?: string; error?: string }>`. YES returns the Stripe setup URL. NO returns a thank-you message.
- `runAceNotices(now)`:
  - keys `ace-ending:${clientId}:${60|30|14}`;
  - the 30 and 14 notices aren't sent once the client said Yes or an Owner set CONTINUING or ENDING;
  - an Owner alert key `ace-no-decision:${clientId}` once the period has passed.
- `runAceBatchReminders(now)`: keys `ace-batch:${batchId}:${7|14}` to `ace.contactEmail`.
- `setAceContactEmail(email)`, added to the Packages page form.

- [ ] **Step 1:** Write tests:
  - **The 60-day notice** is sent once, and the 30-day one is skipped after the client said Yes.
  - **No then Yes** before the end works, and both are in the audit log (Review Focus 3).
  - **The link refuses** after an Owner confirmed ending, or after the end date unless CONTINUING.
  - **The Owner alert** fires after the end with no decision.
  - **The batch reminder** goes out at day 7 to the ACE contact, and not at all once the batch is paid.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it, including the UI changes.
- [ ] **Step 4:** Run the full suite, the build and the smoke test. Expected: all pass.
- [ ] **Step 5:** Commit.

## Done when

- **Automated checks:** CI is green and the smoke test passes.
- **Without a GHL token:** every notice is logged as SKIPPED and nothing breaks.
- **With a token for Book Clarity's GHL:** clients get the reminders and ACE month-6 notices, Owners get alerts, and ACE gets unpaid-batch reminders.
- **The guide** `docs/deploy-vercel.md` covers `GHL_API_TOKEN`, `GHL_LOCATION_ID`, `CRON_SECRET`, `PORTAL_BASE_URL`, the Stripe `invoice.upcoming` and `charge.refunded` webhook events, and switching off Stripe's own failed-payment emails.
