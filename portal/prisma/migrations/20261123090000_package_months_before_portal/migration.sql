-- Months of an additional package that already earned commission before the portal.
ALTER TABLE "ClientSubscription" ADD COLUMN "commissionMonthsBeforePortal" INTEGER NOT NULL DEFAULT 0;
