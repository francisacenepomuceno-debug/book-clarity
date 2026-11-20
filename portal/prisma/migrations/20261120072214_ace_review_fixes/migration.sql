-- AlterTable
ALTER TABLE "AceBatch" ADD COLUMN     "invoiceSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "aceSetupSessionId" TEXT;
