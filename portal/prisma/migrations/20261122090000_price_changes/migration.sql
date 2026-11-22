-- Scheduled package price increases.
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "oldMonthlyCents" INTEGER NOT NULL,
    "newMonthlyCents" INTEGER NOT NULL,
    "oldStripePriceId" TEXT NOT NULL,
    "newStripePriceId" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packageSwitchedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PriceChangeMove" (
    "id" TEXT NOT NULL,
    "priceChangeId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "fromPriceId" TEXT NOT NULL,
    "fromCents" INTEGER NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceChangeMove_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceChangeMove_priceChangeId_clientId_key" ON "PriceChangeMove"("priceChangeId", "clientId");
ALTER TABLE "PriceChange" ADD CONSTRAINT "PriceChange_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PriceChangeMove" ADD CONSTRAINT "PriceChangeMove_priceChangeId_fkey" FOREIGN KEY ("priceChangeId") REFERENCES "PriceChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
