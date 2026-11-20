-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "refundedPackageCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "taxCents" INTEGER NOT NULL DEFAULT 0;
