-- AlterEnum
ALTER TYPE "ClientStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "contractTemplate" TEXT,
ADD COLUMN     "contractVersion" TEXT;

-- CreateTable
CREATE TABLE "Onboarding" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "packageId" TEXT,
    "monthlyCents" INTEGER,
    "onboardingFeeCents" INTEGER,
    "details" JSONB,
    "signedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signerIp" TEXT,
    "signedText" TEXT,
    "signedHash" TEXT,
    "contractVersion" TEXT,
    "quickbooks" TEXT,
    "countersignedAt" TIMESTAMP(3),
    "countersignedById" TEXT,
    "feeInvoiceId" TEXT,
    "feeSetupSessionId" TEXT,
    "feePaidAt" TIMESTAMP(3),
    "stripeSubscriptionId" TEXT,
    "intake" JSONB,
    "intakeAt" TIMESTAMP(3),
    "callBookedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Onboarding_clientId_key" ON "Onboarding"("clientId");

-- AddForeignKey
ALTER TABLE "Onboarding" ADD CONSTRAINT "Onboarding_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
