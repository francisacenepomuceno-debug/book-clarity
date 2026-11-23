-- Several clients (companies) can share one Stripe customer, each with its own subscriptions.
DROP INDEX "Client_stripeCustomerId_key";
CREATE INDEX "Client_stripeCustomerId_idx" ON "Client"("stripeCustomerId");
