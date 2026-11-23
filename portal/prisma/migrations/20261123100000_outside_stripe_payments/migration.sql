-- Clients who pay outside Stripe (Zelle, check, PayPal, bill.com, wire…) and payments marked by hand.
ALTER TABLE "Client" ADD COLUMN "paysOutsideStripe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Client" ADD COLUMN "outsidePaymentMethod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paidOutsideAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "outsideMethod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "outsideReference" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "outsideMarkedById" TEXT;
