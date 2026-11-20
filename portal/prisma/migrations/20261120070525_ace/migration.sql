-- CreateEnum
CREATE TYPE "AcePayment" AS ENUM ('STRIPE', 'OUT_OF_BAND');

-- AlterEnum
ALTER TYPE "CommissionKind" ADD VALUE 'ACE_PREPAID';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "acePrepaidUntil" TIMESTAMP(3),
ADD COLUMN     "aceSlotId" TEXT,
ADD COLUMN     "continuationDecision" TEXT;

-- AlterTable
ALTER TABLE "Package" ALTER COLUMN "stripePriceId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AceBatch" (
    "id" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "totalCents" INTEGER NOT NULL,
    "stripeInvoiceId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidVia" "AcePayment",
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AceBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AceBatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "AceBatchLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AceSlot" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "clientId" TEXT,
    "startDate" TIMESTAMP(3),
    "prepaidUntil" TIMESTAMP(3),
    "customMonthlyCents" INTEGER,

    CONSTRAINT "AceSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AceBatch_stripeInvoiceId_key" ON "AceBatch"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "AceBatchLine_batchId_idx" ON "AceBatchLine"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AceSlot_clientId_key" ON "AceSlot"("clientId");

-- CreateIndex
CREATE INDEX "AceSlot_batchId_packageId_idx" ON "AceSlot"("batchId", "packageId");
