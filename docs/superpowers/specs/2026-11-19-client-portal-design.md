# Book Clarity Client Portal: Design

Status: draft for approval · 2026-11-19

## 1. Intent

Book Clarity runs billing, collections, commissions, onboarding and reporting by hand today. The only automated piece is Stripe autopay. This portal is the system of record for the money side of the business, from "client said yes" onward. (The growth-agent system in `docs/growth-agent-system.md` covers everything up to "call booked".)

It must:

- bill clients automatically each month through Stripe;
- remind clients who are behind or whose payment was declined;
- show at a glance who is current, unpaid or past due;
- calculate executive commissions under Book Clarity's specific rules;
- produce weekly, monthly and yearly sales and business reports;
- run new-client onboarding end to end;
- stay connected to GoHighLevel (GHL), which remains the CRM and messaging layer.

## 2. Goals, non-goals, anti-goals

**Goals (phase 1)**
- Admin portal with role-based access (section 4).
- Stripe-driven billing, including discounts, the 3% credit-card fee, and ACE batches.
- Collections reminders sent through GHL.
- Commission engine with statements and payout tracking.
- Reports: week / month / year.
- Onboarding flow for Direct and ACE clients.
- Strategy-review tracking.
- Import of existing Stripe clients, plus the commission spreadsheet.

**Phase 2 (design for it, don't build it)**
- Client logins: update name, email and payment method, and download monthly or quarterly bookkeeping reports uploaded by staff.

**Non-goals**
- Doing the bookkeeping itself, or syncing with QuickBooks or other accounting software.
- Replacing GHL as the CRM, email/SMS sender or calendar.
- Sales tax calculation (not raised; revisit if needed).
- Automatic service suspension for non-payment (humans decide).

**Anti-goals (a failure even if it "works")**
- Disrupting any existing client's autopay during migration.
- Clients getting duplicate reminders (Stripe and GHL both emailing).
- Charging the 3% fee on a debit card or ACH payment.
- An ACE-prepaid client ever being shown as, or reminded as, past due.
- Admin-role users seeing revenue, reports, discounts or commissions.
- Commission numbers that can't be traced to a specific paid payment.

## 3. Approaches considered

| Option | Trade-off | Decision |
|---|---|---|
| **A. Custom web portal** with its own database, integrated with Stripe (billing) and GHL (messaging, e-sign, calendars) | Fits every business rule; ~$25–60/mo hosting; changes need a developer | **Chosen** by the owner |
| B. Build mostly inside GHL | Cheapest, but GHL payments would conflict with existing Stripe subscriptions; can't do commissions, Admin restrictions or the needed reports | Rejected |
| C. No-code builder (Retool, Softr, Base44) | Fast start, but fee timing, commission rules and Stripe sync strain it; adds lock-in and another subscription | Rejected |

## 4. Users and roles

| Role | People | Access |
|---|---|---|
| Super Admin | the portal owner (the person commissioning this build) | Everything, plus user management and settings (packages, fee rules, state exclusions, reminder timing, commission defaults) |
| Owner | Jose (CEO), Albert | Everything: all clients, discounts, ACE batches, reports, all executives' commissions, marking commissions paid |
| Admin | Alex, Rochelle, Henry | Only four views: **Clients**, **Payments**, **Onboarding**, **Strategy Reviews**. No revenue totals, reports, commissions, discounts or settings |
| Client (phase 2) | each client | Their own profile, payment method and uploaded reports |

Permissions are enforced on the server for every request, not just by hiding menu items.

**Builder's call:** Owner and Super Admin accounts require two-factor sign-in.

## 5. Systems and who owns what

| Concern | Owner system | Notes |
|---|---|---|
| Charging cards/ACH, retries, invoices, receipts | **Stripe** (Billing + Smart Retries) | Existing subscriptions stay untouched |
| Client emails and SMS (reminders, onboarding link, notices) | **GHL** workflows, triggered by the portal | Stripe's own failed-payment and upcoming-invoice customer emails are **turned off** to avoid duplicates. Stripe receipts may stay on (builder confirms with the owner during setup) |
| Agreement e-signature | **GHL Documents & Contracts** | See risk R1 |
| Onboarding call and strategy-review booking | **GHL calendars** | Onboarding: a round-robin calendar for Alex, Rochelle and Henry. Strategy-review calendars will be created by Book Clarity |
| Business rules, commissions, ACE batches, roles, reports, audit log | **Portal** | Portal DB is the reporting source, fed by Stripe and GHL webhooks plus a nightly reconciliation |

The portal also keeps each client's GHL contact updated with tags, custom fields (status, package, type, owner) and a pipeline stage.

## 6. Core concepts

- **Package:** a fixed monthly product (Essentials, Growth, Enterprise, Custom) that maps to a Stripe Price. It has an onboarding-fee amount. A Custom package has a per-client price.
- **Client type**
  - **Direct:** pays Book Clarity from the start.
  - **ACE:** the first 6 months plus onboarding are prepaid by ACE, a third-party company, through a batch.
- **Client status** (shown everywhere)
  - **Onboarding:** hasn't finished the onboarding steps.
  - **Prepaid by ACE:** inside the 6 ACE months. Never billed or reminded.
  - **Current:** latest invoice paid.
  - **Unpaid this month:** invoice open, not yet failed.
  - **Past due:** a payment failed or the invoice is overdue.
  - **At risk:** past due for 21 days or more.
  - **Ended:** cancelled, or an ACE client who didn't continue.
- **Commission owner(s):** one or more executives per client, each with a share. Default is one executive at 10%. A shared client is split, e.g. 5% + 5%.

## 7. Billing rules

### 7.1 Monthly billing (Direct, and ACE clients from month 7)
- One Stripe subscription per client on their package price, billed monthly.
- **First charge is 14 days after the onboarding fee is paid** (a trial or anchor on the subscription). It then bills every month.
- There is a 12-month commitment in the agreement. **After 12 months the subscription simply continues month to month** until cancelled. Cancellation, including early cancellation, is done by hand by an Owner, per the agreement. The portal records the cancellation date and reason.

### 7.2 Discounts (Owner only)
- An Owner picks a client and enters:
  - **percent or fixed dollar amount;**
  - **number of months;**
  - **a required reason.**
- The portal applies it as a Stripe coupon/discount on the subscription with that duration. Billing returns to full price on its own afterwards, and autopay is unaffected.
- **Retroactive discounts:** "apply to a past payment" issues a partial refund on that invoice and records it as a discount.
- Every discount is in the audit log: who, when, amount, months, reason. Reports show the total value of discounts given.

### 7.3 3% credit-card fee
- Applies only when the paying method is a **credit** card (Stripe `card.funding = credit`). **No fee on debit, prepaid or ACH.**
- The fee is 3% of the invoice amount **after discounts**, excluding any existing fee. It appears as its own line: "Credit card processing fee (3%)".
- **Subscription invoices:** when Stripe creates the draft invoice (about 1 hour before finalizing), the portal checks the customer's default payment method and adds the fee line if it's a credit card.
- **One-off payments** (onboarding fee, ACE batch invoice): the payer is shown the fee before confirming whenever they choose a credit card.
- **Mismatches:**
  - An invoice that included the fee but was paid by ACH or debit (e.g. after a decline): the portal refunds the fee portion automatically.
  - An invoice without the fee that was paid by credit card: no fee is collected. It's logged so staff can see it.
- **Settings:** fee on/off globally, the rate (capped at 3%), and a list of **US states where the fee is turned off**. The client's billing state decides.
- **Before go-live:** Book Clarity confirms card-network surcharge registration/notice and the state rules with Stripe or its accountant. This is a launch checklist item, not code.
- The fee is reported as its own revenue line. It is **never** commissionable and is not counted as package revenue.

### 7.4 ACE batches
- An Owner creates a **batch**:
  - the purchase date;
  - the slot counts per package (e.g. 10 Essentials, 4 Growth, 5 Enterprise, 1 Custom at $X);
  - the total amount.

  Each slot means 6 months of service plus onboarding.
- The portal creates one **Stripe invoice to ACE** for the batch. ACE can pay by ACH (no fee) or credit card (3% fee).
- **"Record payment received"** handles bank transfers or checks. It takes the method, date and reference, and marks the Stripe invoice paid out-of-band.
- Unpaid batch invoices send reminders to **ACE's contact**, never to clients.
- During onboarding an ACE client is assigned to an open slot of the right package. The **6 months start on the client's onboarding date**, meaning the date they're assigned and the onboarding fee step is waived.
- The batch view shows slots used and open per package, and whether the batch is paid.
- **About 30 days before month 6 ends:** the client is flagged, and a GHL "Would you like to continue?" workflow starts.
  - **Yes:** the client gets a link to save a payment method (card or ACH). Their direct subscription starts on the day after the 6 ACE months end, and the 3% rule applies.
  - **No, or no answer by the end date:** the client is marked Ended. A staff member confirms; the portal doesn't decide by itself.

## 8. Collections and reminders

All of these are sent through GHL. Timings live in settings.

| When | What |
|---|---|
| 3 days before each monthly charge | "Upcoming payment" notice |
| Payment declined (day 0) | Email + SMS with a secure link to update the card or switch to ACH (Stripe-hosted update link). The message mentions there's no fee for ACH |
| Still unpaid on day 3, 7 and 14 | Follow-up reminders. Stripe Smart Retries run in the background |
| Day 21 | Status becomes **At risk**. Owners get an alert. No automatic suspension |
| Paid | Reminders stop at once. The status returns to Current |

ACE-prepaid clients are excluded from every client reminder.

## 9. Commissions

**Commissionable base:** the monthly package amount actually paid, after discounts. It excludes:
- onboarding fees;
- the 3% card fee;
- taxes;
- refunds (handled as clawbacks).

**Rate and split:** set per client. The default is 10% to one executive. A shared client is split, e.g. Jose 5% + Albert 5%. Uneven splits and different totals are allowed, and the shares must add up to the client's rate. Changes take effect from a chosen date forward and never rewrite past statements. Executives are a managed list, starting with Jose and Albert.

**Earning windows**

| Client type | Window | When it's earned |
|---|---|---|
| Direct | First **12 paid** monthly invoices | Each month, when that payment clears |
| ACE, months 1–6 | 6 months | **All at once**, on the client's onboarding date, once the batch payment has cleared. If the batch isn't paid yet, it shows as *pending* until it clears. Base = 6 × the package's monthly price (see open question Q1) |
| ACE, months 7–12 (if the client continues) | Next **6 paid** monthly invoices | Each month, when that payment clears |

**Other rules**
- **Late payments:** commission counts in the period when the money arrived.
- **Refunds:** if a commissioned payment is later refunded, a negative line (a clawback) goes on the executive's next statement.
- **An ACE client who leaves before month 6:** months 1–6 commission stays, since ACE paid in full.

**Statements:** monthly statements per executive (builder's call: calendar months, in the business timezone). Each line shows the client, invoice, paid date, base, rate and commission. Owners mark a statement **Paid** with a date, and paid statements are locked. Each client shows how many commission months remain.

## 10. Onboarding

1. **Admin/Owner creates the client.** They enter:
   - name and contact;
   - type (Direct or ACE; for ACE, the batch slot);
   - commission owner(s), rate and split;
   - any approved discount.

   The portal creates the GHL contact and sends the client a personal onboarding link through GHL.
2. **The client's link is a step-by-step flow** that resumes where they left off:
   - **a. Pick a package.** Skipped for ACE, where it comes from the slot.
   - **b. Sign the agreement** (GHL Documents & Contracts).
   - **c. Pay the onboarding fee and save a payment method** (card or ACH, with the 3% rule). Skipped for ACE. The Stripe subscription is created here with its first charge 14 days later.
   - **d. Fill out the questionnaire.** Built into the portal. The answers are stored with the client and sent to GHL custom fields.
   - **e. Book the onboarding call** on the round-robin GHL calendar (Alex, Rochelle, Henry).
3. **A client stuck on any step for 3 days** gets an automatic GHL reminder.
4. **Onboarding view:** each client is **Done** (with the call date and time), **Upcoming** (with the booked date and time) or **Not scheduled**.

**Builder's call:** the questionnaire's questions are editable in Settings. Book Clarity supplies the initial question list.

## 11. Strategy reviews

- At the onboarding call, the staff member sets the client's review cadence (**Monthly** or **Quarterly**) in the portal and books the first review.
- Reviews are booked on GHL calendars that Book Clarity will create. The portal reads those bookings through GHL appointment webhooks.
- **Strategy Reviews view:**
  - each client's cadence, last review date and next scheduled date;
  - **Due, not booked** when the next one is due and nothing is on the calendar;
  - **Overdue.**

## 12. Screens

- **Clients** (all roles): client list with status, Direct/ACE, package, and next charge date. Owners also see owner/split, discount, payment method and amounts. Each client has a detail page with a payment history and timeline.
- **Payments** (all roles): this month's successful and failed payments per client. Admins see the status only; Owners also see amounts.
- **Onboarding** (all roles): see section 10.
- **Strategy Reviews** (all roles): see section 11.
- **Dashboard** (Owner and Super Admin):
  - this month's expected vs collected revenue;
  - counts by status;
  - alerts: declines, At-risk clients, ACE clients nearing month 6, batches with open slots, discounts ending, stuck onboarding.
- **ACE Batches** (Owner and Super Admin).
- **Commissions** (Owner and Super Admin): statements per executive, mark paid, unassigned clients.
- **Reports** (Owner and Super Admin): see section 13.
- **Settings and Users** (Super Admin).
- **Audit log** (Owner and Super Admin).

## 13. Reports

These can be viewed by week, month or year, and each one compares against the previous period. They export to CSV and PDF.

- **Revenue collected,** split into monthly packages, onboarding fees, ACE payments and card fees. Shown both overall and per package.
- **Expected vs collected,** with the outstanding amount past due.
- **New clients** by package and by Direct/ACE.
- **Cancellations and ended clients.**
- **ACE continuation rate:** the share of ACE clients who continue into month 7.
- **Active clients** and **monthly recurring revenue (MRR)** over time.
- **Value of discounts given.**
- **Commissions earned per executive,** and paid vs unpaid.

**Revenue basis:** cash collected, by the date of payment. An ACE batch counts on the date it's paid. (Builder's call. Accrual reporting is not in scope.)

## 14. Migrating existing clients

1. **Read-only sync:** pull all Stripe customers, active subscriptions and invoice history. Each subscription is mapped to a package by its price. No subscription is changed.
2. **Import the commission spreadsheet** (provided by Book Clarity). For each client it sets:
   - Direct or ACE;
   - commission owner(s), rate and split;
   - **how many commission months have already been earned or paid,** so the remaining window is correct.

   Rows that don't match go to an "Unassigned" list for an Owner to fix.
3. **Turn on the card-fee rule for existing card clients** only after Book Clarity gives existing clients notice (launch checklist).
4. **Switch off Stripe's customer reminder emails** the same day the GHL reminders go live.

## 15. Technical design (builder's calls unless stated)

- **App:** Next.js (TypeScript), server-rendered admin UI, hosted on Vercel.
- **Database:** Postgres (e.g. Neon or Supabase) with Prisma. All money is stored as integer cents in USD.
- **Auth:** email-based login with roles. Two-factor sign-in for Owner and Super Admin.
- **Integrations**
  - **Stripe:** API plus webhooks (`invoice.created`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `customer.subscription.*`, `payment_method.*`).
  - **GHL:** API v2 with a Private Integration token for one location, plus webhooks for contract signed and appointment booked/changed.
  - All webhook handlers verify signatures and are idempotent.
- **Jobs:** scheduled jobs for the reminder schedule, the ACE month-6 flags, the strategy-review due checks, the stuck-onboarding reminders, and a nightly Stripe reconciliation.
- **Audit log** for discounts, refunds, commission changes, statement payouts, manual payments and role changes.
- **Business timezone** is a setting. Weeks run Monday to Sunday.
- **Environments:** Stripe test mode and a GHL sandbox or sub-account for staging. Live keys go only in production.

## 16. Risks

- **R1: GHL Documents & Contracts API coverage.** The API may not reliably support sending a contract and receiving a "signed" event. The builder should confirm this early. Fallbacks:
  - embed the GHL signing link and confirm signing by polling or a webhook;
  - or use a dedicated e-sign service (decided with the owner).
- **R2: Surcharge compliance** (section 7.3). Needs business and legal sign-off before the fee goes live.
- **R3: Messy spreadsheet data.** The Unassigned list and a dry-run import preview reduce the risk.

## 17. What Book Clarity provides before building

- Stripe account access (a restricted API key and webhook setup). Test mode first.
- A GHL Private Integration token for the location, plus calendar IDs once the calendars are created.
- The commission spreadsheet.
- The package list with onboarding-fee amounts.
- The agreement template in GHL.
- The questionnaire questions.
- ACE's billing contact.

## 18. Decisions from the builder check

These were settled as builder/design calls (marked so the owner can check them):

- **D1: Admins creating clients (my call).** Admins can create a client and send the onboarding link. Commission owner, rate, split and discount fields are hidden from Admins. A client created by an Admin shows on the Owners' dashboard as **"Needs Owner setup"** until an Owner fills those in. It is also listed under Commissions → Unassigned.
- **D2: Existing ACE clients at migration (my call).** Owners re-enter past ACE batches through a **historical batch** form (purchase date, slots, amount, paid or not). They then assign each existing ACE client to a slot with their real start date. The spreadsheet import gets optional columns for `ace_start_date` and `ace_batch`. **The card-fee rule and GHL reminders stay off until every imported ACE client has a start date,** so no ACE-prepaid client can be reminded by mistake.
- **D3: Retroactive discounts and refunds (my call).** A retroactive discount refund is treated like any refund: a proportional commission clawback on the next statement. Any 3% fee on that invoice is refunded in proportion.
- **D4: E-sign fallback (my call).** If the GHL contracts API can't send contracts or report signing, the fallback is to embed GHL's signing link and confirm by polling, with an Owner able to mark "signed" manually. A paid e-sign service is only added with the owner's approval.
- **D5: Executive role (my call).** The commission engine supports any number of executives. A login role that shows only one executive's own statements is **not built in phase 1**, since only Owners earn commission today. The data model allows adding it later.
- **D6: ACE client continuing but no payment method yet (my call).** New status **"Continuing: awaiting payment method"**. The client, not ACE, gets payment-setup reminders starting 14 days before the ACE period ends. No charge is attempted without a saved method. If nothing is saved by the end date, Owners get an alert and decide.

## 19. Open questions for the owner

_(Answers pending; see the conversation.)_
