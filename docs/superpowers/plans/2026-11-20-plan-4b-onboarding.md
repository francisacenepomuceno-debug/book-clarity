# Plan 4B: Onboarding, Contracts and Auto-Suspension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new client gets one link and completes onboarding on their own:

1. choose a package;
2. enter their details;
3. read and sign their package's contract;
4. pay the onboarding fee by bank or card;
5. fill in the intake form;
6. book the onboarding call.

Jose countersigns each contract. Staff see where every client is. Clients still unpaid on day 30 are suspended automatically.

**Architecture:**
- **Onboarding record:** one `Onboarding` row per client holds the progress.
- **Steps:** a pure function `nextStep()` decides the client's next step.
- **Contract templates:** each package's contract is stored on the `Package` row, loaded from `portal/contracts/*.txt`. A pure `renderContract()` fills in the fields. The exact signed text and its SHA-256 are kept.
- **Payment:** reuses the ACE bank-or-card pattern. A Stripe setup session saves the method. On completion the portal charges the onboarding fee (plus 3% on credit cards) and, once it's paid, starts the subscription with its first charge 14 days later.

**Spec:** `docs/superpowers/specs/2026-11-19-client-portal-design.md` §10, §20, and the owner answers of 2026-11-20 (below).

## Global Constraints (owner, 2026-11-20)

- **Contract text:** each package's contract is used **exactly as provided**. Only the blanks are filled in, plus the approved billing wording:
  - billing starts 14 days after the onboarding fee, then on that date each month;
  - the onboarding fee is charged at signup;
  - Auto-Pay mentions ACH.

  The signed copy stores the full rendered text, its SHA-256, the date and time, the IP address and the typed name.
- **Countersigning:** **Jose countersigns each contract.** When a client signs, the configured countersigner (setting `countersignerUserId`, default the first Owner) gets an email with a link. Countersigning **doesn't block** the client's next steps. After countersigning, the client is emailed the fully signed copy.
- **Billing:**
  - The **onboarding fee** is charged at signup (credit card adds 3%; debit and ACH don't).
  - The **first monthly charge** is **14 days after the fee is paid**, then monthly on that date. It goes on a Stripe subscription with `trial_end`.
  - **ACE clients** skip choosing a package and paying.
- **Auto-suspend (no late fees):** when a subscription invoice is still unpaid **N days** after its first failure (setting `suspendAfterDays`, default **30**):
  - pause the Stripe subscription with `pause_collection: { behavior: "void" }`;
  - set status `SUSPENDED`;
  - notify the client, Owners and Admins.

  When the client pays, or an Owner clicks Resume, collection resumes and the status is recalculated. ACE-prepaid and ended clients are never suspended.
- **Who can do what:**
  - **Admins and Owners** can create a client and send the onboarding link. Commission and discount stay Owner-only (D1).
  - **Countersigning** is for Owners and the Super Admin.
- **Public pages:** the client pages live at `/onboard/<signed token>`, POST for every state change (link scanners), and never expire. They stop working once onboarding is complete or the client has ended.
- **Intake questions:** editable in Settings, with a draft default list.
- **Booking the call:** until GHL calendar sync lands (Plan 4C), the client books on the GHL calendar link (setting `onboardingCalendarUrl`) and confirms "I've booked my call".

## Review Focus

1. **The same payment link is used twice, or the webhooks arrive twice.** The fee is charged once and one subscription is created. Covered by a Task 4 test.
2. **The contract template is edited after a client signed.** The client's signed copy is unchanged. Covered by a Task 1 test.
3. **The client pays by ACH, which clears days later.** The subscription starts 14 days after the payment clears, not after signup. Covered by a Task 4 test.
4. **A suspended client pays.** They're resumed automatically. A client who pays on day 29 is never suspended. Covered by a Task 6 test.
5. **A public link is tampered with, or onboarding is already finished.** The link is refused. Covered by a Task 3 test.

---

### Task 1: Contract templates and rendering

- Store each package's contract on `Package` as `contractTemplate String?` and `contractVersion String?` (the first 12 characters of a SHA-256).
- `scripts/load-contracts.ts` matches files by package name: Essentials → `essentials.txt`, Growth → `growth.txt`, Enterprise → `enterprise.txt`, and Enterprise Custom or Custom → `enterprise-custom.txt`.
- `renderContract(template, values, signatures?) → { text, missing: string[] }`, in `src/domain/contract.ts`, is pure. It fills `{{field}}` values and shows checks, choices and signatures as their chosen or signed state.
- The Packages page shows each package's contract, and Owners can edit it, which changes the version.
- **Tests:**
  - every placeholder in the four repo templates can be rendered;
  - `missing` lists empty required fields;
  - editing a template changes the version but not an already-signed copy (Review Focus 2).

### Task 2: Onboarding record and the "New client" start (staff)

- Model `Onboarding`: `clientId` (unique), `packageId`, `monthlyCents`, `onboardingFeeCents`, `details` (JSON), the contract fields (`signedAt`, `signerName`, `signerIp`, `signedText`, `signedHash`, `contractVersion`, `quickbooks`), `countersignedAt`, `countersignedById`, `feeInvoiceId`, `feePaidAt`, `intake` (JSON), `intakeAt`, `callBookedAt`, `completedAt`, `createdById` and timestamps.
- `startOnboarding({ name, email, phone?, type: "DIRECT" | "ACE", packageId?, customMonthlyCents?, onboardingFeeCents? })`:
  - Admins and Owners can call it;
  - it creates the Client and the Onboarding, and sends the link through GHL (`onboarding-invite:<id>`);
  - it returns the link so staff can copy it.
- `nextStep(onboarding, client) → "package" | "details" | "contract" | "payment" | "intake" | "call" | "done"`, which is pure. ACE clients skip `package` and `payment`.
- An Onboarding view (`onboarding.view`) groups clients into Not started, In progress (current step), Done (with the date the call was booked) and Waiting on countersign. It includes a "New client" form.
- **Tests:** `nextStep` for Direct and ACE; Admins can start onboarding but the commission and discount fields aren't accepted from them; the link is sent once.

### Task 3: Client pages (package, details, contract, intake, call)

- Public `/onboard/[token]` shows the current step.
- Each step posts to a server action that checks the token and the current step.
- **Signing** stores the rendered text, a hash, the IP address (from `x-forwarded-for`), the typed name (which must match the details name, ignoring case) and the QuickBooks choice. It then notifies the countersigner (`countersign-request:<onboardingId>`).
- **Tests:**
  - a step can't be skipped;
  - a tampered token is refused;
  - a finished onboarding is refused;
  - signing stores the exact text and hash;
  - signing needs both checkboxes and a name (Review Focus 5).

### Task 4: Onboarding fee (bank or card) and the subscription

- The payment step reuses the choice page.
  - **Bank:** a Stripe invoice for the onboarding fee (ACH or bank transfer), sent to the client's hosted page.
  - **Card:** a setup session (`ONBOARDING_CARD`). When it completes, the portal invoices the fee plus 3% for credit cards and charges it.
  - The invoice metadata is `{ kind: "ONBOARDING", onboardingId }`.
- `invoice.paid` with kind ONBOARDING:
  - sets `feePaidAt`;
  - creates the subscription on the package price (or a Custom price), with `trial_end = paidAt + 14 days` and the saved payment method as default;
  - uses idempotency key `bc-onb-sub-<onboardingId>`.

  For ACH, the default payment method comes from the paid invoice's charge.
- **Tests:**
  - a credit card adds 3% and a debit card doesn't;
  - paying twice creates one subscription (Review Focus 1);
  - with ACH, the trial counts from the date the payment cleared (Review Focus 3);
  - the onboarding fee earns no commission (it's kind ONBOARDING).

### Task 5: Countersigning, intake settings, stuck reminders

- **Countersigning:** `/contracts/[onboardingId]` (Owners and Super Admin) shows the signed text and a **Countersign** button. On countersigning, the portal stores who signed and when, and emails the client the fully signed copy (`contract-executed:<id>`).
- **Settings → Onboarding:** the intake questions (one per line, written as `Question | text/long/yesno/choice:a,b`), the countersigner, the onboarding calendar URL and `suspendAfterDays`.
- **Cron reminders:**
  - a client with no progress for 3 days gets a nudge (`onboarding-nudge:<id>:<step>`, at most one per step);
  - Owners are reminded about a contract still not countersigned after 2 days.
- **Tests:** countersigning is Owner-only and emails once; a nudge goes out once per step; the intake defaults parse.

### Task 6: Auto-suspension

- `runSuspensions(now)` runs in the daily cron. It checks open SUBSCRIPTION invoices with `firstFailedAt ≤ now − suspendAfterDays` where the client isn't suspended, ACE-prepaid or ended. For each:
  - it pauses the Stripe subscription (idempotency key `bc-suspend-<invoiceId>`);
  - it sets the client to SUSPENDED and writes an audit entry;
  - it notifies the client, Owners and Admins.
- `invoice.paid` for a suspended client resumes collection (`pause_collection: null`) and refreshes the status. An Owner can also click **Resume**.
- Statuses: add `SUSPENDED` to the enum, and `deriveClientStatus` gives SUSPENDED ahead of past-due when `client.suspendedAt` is set.
- **Tests:** a client is suspended on day 30 and not on day 29, and only once; paying resumes them; ACE-prepaid clients are never suspended (Review Focus 4).

## Done when

- **Automated checks:** CI is green and the smoke test covers a new client from the start link through signing.
- **For Owners:** they can countersign, and suspended clients show up, can be resumed, and resume by themselves when they pay.
