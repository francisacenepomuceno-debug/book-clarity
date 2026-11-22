-- A client can have several subscriptions on the same package: one move per subscription.
DROP INDEX "PriceChangeMove_priceChangeId_clientId_key";
CREATE UNIQUE INDEX "PriceChangeMove_priceChangeId_subscriptionId_key" ON "PriceChangeMove"("priceChangeId", "subscriptionId");
