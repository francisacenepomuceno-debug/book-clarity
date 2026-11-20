-- AlterTable
ALTER TABLE "AceBatch" ADD COLUMN     "cardFeeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "backfilled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "billedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "dueAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AuditLog_at_id_idx" ON "AuditLog"("at", "id");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- CreateIndex
CREATE INDEX "Invoice_paidAt_idx" ON "Invoice"("paidAt");

-- CreateIndex
CREATE INDEX "Invoice_billedAt_idx" ON "Invoice"("billedAt");

-- Existing rows: Stripe's period_end is the bill date for subscription invoices (period_start looks back a cycle).
UPDATE "Invoice" SET "billedAt" = "periodEnd";
