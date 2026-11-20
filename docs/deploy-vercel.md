# Putting the Book Clarity Portal on Vercel

This takes about 20 minutes. You need to be signed in to Vercel (with the GitHub account that owns `book-clarity`), Stripe and an authenticator app on your phone.

> **Plan:** Vercel's free Hobby plan is for non-commercial use only, so a business portal needs **Vercel Pro** (about $20/month). The Neon Postgres free tier is enough to start.

## 1. Choose which branch goes live

The portal code is on the branch in pull request #1. Either:

- **merge pull request #1** (recommended), so the default branch has the portal and Vercel deploys from it; or
- leave it unmerged and, after step 2, set **Settings → Git → Production Branch** to `claude/ecstatic-ramanujan-1kuwjl`.

## 2. Create the Vercel project

1. In Vercel, go to **Add New… → Project** and import the `book-clarity` repository.
2. Set **Root Directory** to `portal`. Vercel detects Next.js and uses the build command `npm run vercel-build`, which also sets up the database tables.
3. **Don't deploy yet.** Click into **Environment Variables** first, or cancel the first deploy if it starts on its own; it fails until steps 3–4 are done.

## 3. Add the database

1. In the project, open **Storage → Create Database → Neon (Postgres)**.
2. Pick a region close to you, such as US East, and **connect it to this project** for all environments.
3. This adds `DATABASE_URL` and `DATABASE_URL_UNPOOLED` automatically.

## 4. Add the settings

In **Settings → Environment Variables**, add the following:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | A new **restricted, read-only** Stripe key: Stripe → Developers → API keys → Create restricted key, with **Read** on Customers, Subscriptions, Invoices, Charges, Payment Methods, Products and Prices. |
| `AUTH_SECRET` | A random value of 64 or more characters. Use your password manager's generator. It signs sign-in sessions; changing it signs everyone out. |
| `SETUP_TOKEN` | A setup code you make up, of 20 or more characters. It's used once in step 6. |
| `BUSINESS_TZ` | `America/New_York`, or your time zone. |
| `PORTAL_BASE_URL` | Your site's address, e.g. `https://<your-project>.vercel.app`, with no slash at the end. **Required:** every link in client emails and texts is built from it. Until it's set, no messages are sent. Update it if you add your own domain (step 8). |
| `CRON_SECRET` | A random value of 32 or more characters. Vercel uses it to run the daily reminder job; without it, no date-based reminders go out. |
| `GHL_API_TOKEN` | Book Clarity's GHL Private Integration token (step 6b). Leave it empty until you're ready; messages are just logged as skipped. |
| `GHL_LOCATION_ID` | Book Clarity's GHL sub-account (location) ID (step 6b). |
| `STRIPE_WEBHOOK_SECRET` | Leave this for step 7. |

## 5. Deploy

Go to **Deployments → Redeploy**, or push to the production branch. When it finishes, open the site at `https://<your-project>.vercel.app`.

## 6. Create your Super Admin login (once)

1. Go to `https://<your-project>.vercel.app/setup`.
2. Enter the `SETUP_TOKEN`, your email and your name.
3. The page shows your **temporary password** and an **authenticator QR code** once:
   - Scan the QR code with Google Authenticator, Microsoft Authenticator or 1Password.
   - Save the password in your password manager.
4. Sign in at `/login` with your email, the password and the 6-digit code.
5. **Delete `SETUP_TOKEN`** in Vercel → Environment Variables. The setup page stops working anyway once a user exists.
6. Open **Users**, in the top bar, and add the team:
   - Jose and Albert: **Owner**. They get a password and an authenticator QR code.
   - Alex, Rochelle and Henry: **Admin**. They get a password only.

   Each person's details are shown once. Send them privately.

## 6b. Connect Book Clarity's GHL (for reminders and notices)

Use **Book Clarity's own GHL account** (not any other business's sub-account).

1. In GHL, open the Book Clarity sub-account → **Settings → Private Integrations → Create new integration**.
2. Give it the scopes **contacts.write**, **contacts.readonly**, **conversations/message.write** and **conversations.readonly**.
3. Copy the token into Vercel as `GHL_API_TOKEN`, and the sub-account's **Location ID** (Settings → Business Profile) as `GHL_LOCATION_ID`. Redeploy.
4. Make sure the sub-account can send email (a sending domain) and SMS (a phone number) in GHL.

Messages appear in each contact's GHL **Conversations**. The schedule lives in the portal: 3 days before a charge; on a decline and days 3, 7 and 14; an Owner alert at day 21; ACE clients 60, 30 and 14 days before their prepaid period ends; ACE batch reminders at 7 and 14 days.

## 7. Connect Stripe's live updates

1. In Stripe, go to **Developers → Webhooks → Add endpoint**.
2. Set the URL to `https://<your-project>.vercel.app/api/stripe/webhook`.
3. Select these events:
   - `invoice.created`, `invoice.finalized`, `invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `customer.updated`
   - `invoice.upcoming`, `charge.refunded`, `checkout.session.completed`
   - `payment_intent.processing` (bank payments clearing) and `setup_intent.succeeded` (a new client saved their bank account or card during onboarding)
4. Copy the endpoint's **Signing secret** (it starts `whsec_`) into Vercel as `STRIPE_WEBHOOK_SECRET`, then **Redeploy**.
5. In Stripe, the endpoint's next deliveries should show **200 OK**.

## 7b. Stop Stripe's own reminder emails

The portal sends reminders through GHL, so turn off Stripe's duplicates the same day GHL is connected: in Stripe, **Settings → Billing → Subscriptions and emails**, turn off the emails for **failed payments** and **upcoming renewals**. Keep **Smart Retries** on. Also:
- Turn off Stripe's reminder emails for **invoices sent to customers** (the ACE batch invoices). The portal sends those reminders to ACE through GHL.
- Set the **upcoming renewal events** lead time to **3 days** (Settings → Billing → Subscriptions and emails). The portal's "payment coming up" notice uses it.
- In the **Customer portal** settings, allow updating payment methods with **card and US bank account (ACH)**. Turn **off** cancelling subscriptions and changing plans. The "update payment method" link in reminders opens only the payment-method page, but this keeps anything else off. Also enable the **Customer portal** (Settings → Billing → Customer portal) with "update payment methods" allowed; the "update payment method" links use it.

## 7c. Load past invoices for Reports (once)

Reports read the portal's own copy of your Stripe invoices. New invoices arrive by webhook; this copies the history. It only reads from Stripe and is safe to run again.

1. Open the portal's dashboard once, so your existing clients are synced.
2. On your computer, in the `portal` folder, with the production `DATABASE_URL` and `STRIPE_SECRET_KEY` set, run:

   ```bash
   npx tsx scripts/backfill-invoices.ts --since 2025-01-01
   ```

It is designed to be safe on live data:
- Old unpaid invoices are copied without a "failed on" date, so they never trigger payment reminders or suspension.
- Copied invoices never earn commission or count toward a client's 12 commission months; months paid before the portal are entered on each client ("months before the portal") instead.
- Clients who have left (all their subscriptions cancelled) are added as ended clients, so past revenue includes them. ACE's own Stripe customer is skipped.

## 7d. Go-live: move existing clients in, then switch on

Do these in order. Nothing here changes anything in Stripe. Client notices and the 3% card fee stay **off** until step 9.

1. **Sync clients:** open the dashboard once. Every Stripe subscription becomes a portal client, and each is linked to its package when the package name or Stripe price matches.
2. **Load history:** run the backfill (section 7c).
3. **Packages:** on the Packages page, set each package's Stripe price and check its contract. The page lists any client that isn't linked to a package yet.
4. **Past ACE batches:** on the ACE page, add each past batch with **Already paid** and **Historical** ticked. Historical batches never post the months 1–6 commission again, because it was already settled.
5. **Commission spreadsheet:** go to Commissions → **Import the commission spreadsheet**, download the template, fill it in and upload it. Check the preview, then press **Apply**. Rows that don't match are listed for you to fix; importing again is safe.
6. **Fix what's left:** fix the import's unmatched rows and the Commissions → "Clients without an owner" list.
7. **Checklist:** the Super Admin opens **Launch** (top bar). Work through the automatic checks and tick each manual item when it's done:
   - surcharge registration;
   - telling card clients about the fee;
   - Stripe's own reminder emails off;
   - customer portal set up;
   - webhook events on;
   - a test-mode run;
   - history loaded.
8. **Before notices go on,** every active ACE client must have a start date (step 5 or the ACE page), so no prepaid client is reminded to pay.
9. **Turn on client notices** on the Launch page. Then **turn on the card fee** once card-paying clients have had notice.

## 8. Optional: your own address

To use your own address, such as `portal.bookclarity.com`:

1. In Vercel, go to **Settings → Domains** and add the domain.
2. Add the DNS record Vercel shows at your domain provider.
3. Update the Stripe webhook URL to the new address.

## What works with the read-only key

| Feature | Read-only key |
|---|---|
| Client dashboard | Works |
| Client pages | Works |
| Live status updates | Works |
| Logins and Users | Works |
| **Discounts** | **Doesn't work** |
| 3% card-fee automation | Switched off by default, so no write access needed |

Discounts need Stripe write access. When you're ready to use them, make a restricted key with **Write** on Coupons, Subscriptions and Refunds, plus the Read permissions above, and replace `STRIPE_SECRET_KEY`.

Before the card fee is switched on, it must be checked end to end with a Stripe test-mode key, and the surcharge rules confirmed.
