-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "continuationBy" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "processingSince" TIMESTAMP(3);
