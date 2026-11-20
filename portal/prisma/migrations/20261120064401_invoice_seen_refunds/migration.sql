-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "seenRefundIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
