-- What Stripe calls a subscription (product names), shown when it is not linked to a portal package.
ALTER TABLE "ClientSubscription" ADD COLUMN IF NOT EXISTS "productName" TEXT;
