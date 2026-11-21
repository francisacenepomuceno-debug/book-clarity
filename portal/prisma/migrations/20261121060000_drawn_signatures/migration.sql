-- Drawn signatures for the client and the countersigner.
ALTER TABLE "Onboarding" ADD COLUMN "signatureImage" TEXT;
ALTER TABLE "Onboarding" ADD COLUMN "countersignatureImage" TEXT;
