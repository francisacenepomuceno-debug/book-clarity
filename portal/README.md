# Book Clarity Portal

This is the first slice: a **read-only live client dashboard** built from Stripe. The full build is described in
`docs/superpowers/plans/`.

## Run locally

1. Copy `.env.example` to `.env.local` and fill it in:
   - `STRIPE_SECRET_KEY`: a **restricted, read-only** Stripe key with Read on Customers, Subscriptions, Invoices, Charges, Payment Methods, Products and Prices.
   - `DASHBOARD_PASSWORD`: the page is protected by basic auth with user `bookclarity`.
2. Install and start the dashboard:

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

   ```bash
   npm start
   ```

3. Open http://localhost:3000.

Behind an HTTPS proxy (as in the Claude cloud environment), start with `NODE_USE_ENV_PROXY=1`.

## What it shows

Every non-cancelled Stripe subscription, with:

- **Status:** Current, Unpaid this month, Past due, At risk (21+ days), Paused
- **Package:** Essentials, Growth, Enterprise or Enterprise Custom, plus any 6-month contract
- **Prices:** monthly list price, and the existing 3% card fee shown separately
- **Billing:** payment method, or "Emailed invoice" for subscriptions that aren't on autopay
- **Dates and amounts:** next charge date, amount due, and the date the client went past due

The portal never writes to Stripe. Data is cached for 60 seconds; use **Refresh** to reload.

**Do not deploy this publicly** until real logins (Plan 1, Task 2) replace the temporary password.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```
