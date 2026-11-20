-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('EARNED', 'CLAWBACK');

-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('OPEN', 'PAID');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "commissionMonthsBeforePortal" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "onboardingCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Executive" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Executive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionShare" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "executiveId" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionEntry" (
    "id" TEXT NOT NULL,
    "executiveId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "CommissionKind" NOT NULL,
    "refundKey" TEXT NOT NULL DEFAULT '',
    "windowIndex" INTEGER,
    "baseCents" INTEGER NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "month" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionStatement" (
    "id" TEXT NOT NULL,
    "executiveId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'OPEN',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "totalCents" INTEGER,

    CONSTRAINT "CommissionStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Executive_name_key" ON "Executive"("name");

-- CreateIndex
CREATE INDEX "CommissionShare_clientId_effectiveFrom_idx" ON "CommissionShare"("clientId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CommissionEntry_executiveId_month_idx" ON "CommissionEntry"("executiveId", "month");

-- CreateIndex
CREATE INDEX "CommissionEntry_clientId_idx" ON "CommissionEntry"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionEntry_executiveId_invoiceId_kind_refundKey_key" ON "CommissionEntry"("executiveId", "invoiceId", "kind", "refundKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStatement_executiveId_month_key" ON "CommissionStatement"("executiveId", "month");
