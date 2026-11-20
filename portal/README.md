# Book Clarity Portal

This is the first slice: a **read-only live client dashboard** built from Stripe. The full build is described in
`docs/superpowers/plans/`.

## Deploy

See `docs/deploy-vercel.md` for the step-by-step Vercel setup.

## Run locally

1. Copy `.env.example` to `.env.local` and fill it in:
   - `STRIPE_SECRET_KEY`: a **restricted, read-only** Stripe key with Read on Customers, Subscriptions, Invoices, Charges, Payment Methods, Products and Prices.
   - `DATABASE_URL`: a Postgres 16 database.
   - `AUTH_SECRET`: 32 or more random characters, used to sign login sessions.
   - `STRIPE_WEBHOOK_SECRET`: the signing secret for Stripe webhooks.
2. Install, set up the database and create the first Super Admin:

   ```bash
   npm install
   ```

   ```bash
   npx prisma migrate deploy
   ```

   ```bash
   npx tsx scripts/create-user.ts you@example.com "Your Name" SUPER_ADMIN
   ```

   This prints a temporary password and an authenticator setup key once. Add the key to an authenticator app
   (Google Authenticator, Microsoft Authenticator, 1Password). Use the same script to add Owners (`OWNER`) and
   Admins (`ADMIN`); Admins don't need an authenticator.

   Then build and start the portal:

   ```bash
   npm run build
   ```

   ```bash
   npm start
   ```

3. Open http://localhost:3000 and sign in. Owners and Super Admins also enter the 6-digit code from their authenticator app.

After 5 wrong passwords or codes, sign-in is locked for 15 minutes.

Behind an HTTPS proxy (as in the Claude cloud environment), start with `NODE_USE_ENV_PROXY=1`.

## What it shows

Every non-cancelled Stripe subscription, with:

- **Status:** Current, Unpaid this month, Past due, At risk (21+ days), Paused
- **Package:** Essentials, Growth, Enterprise or Enterprise Custom, plus any 6-month contract
- **Prices:** monthly list price, and the existing 3% card fee shown separately
- **Billing:** payment method, or "Emailed invoice" for subscriptions that aren't on autopay
- **Dates and amounts:** next charge date, amount due, and the date the client went past due

The portal never writes to Stripe. Data is cached for 60 seconds; use **Refresh** to reload.

Admins see the client list without amounts or payment details.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```
