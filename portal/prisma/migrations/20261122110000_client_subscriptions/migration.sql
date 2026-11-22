-- A client can pay for several packages, each its own Stripe subscription.
CREATE TABLE "ClientSubscription" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "packageId" TEXT,
    "status" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientSubscription_stripeSubscriptionId_key" ON "ClientSubscription"("stripeSubscriptionId");
CREATE INDEX "ClientSubscription_clientId_idx" ON "ClientSubscription"("clientId");
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientSubscription" ADD CONSTRAINT "ClientSubscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every client's existing (main) subscription, with its package.
INSERT INTO "ClientSubscription" ("id", "clientId", "stripeSubscriptionId", "packageId", "status", "endedAt")
SELECT 'cs_' || "id", "id", "stripeSubscriptionId", "packageId", "subscriptionStatus", "endedAt" FROM "Client" WHERE "stripeSubscriptionId" IS NOT NULL;

-- Which subscription an invoice bills (filled from Stripe on the next sync/backfill; older rows count as the main one).
ALTER TABLE "Invoice" ADD COLUMN "stripeSubscriptionId" TEXT;
CREATE INDEX "Invoice_stripeSubscriptionId_idx" ON "Invoice"("stripeSubscriptionId");
