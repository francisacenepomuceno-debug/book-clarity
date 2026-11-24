-- The onboarding call as seen on Book Clarity's GHL calendar.
ALTER TABLE "Onboarding" ADD COLUMN "callStartsAt" TIMESTAMP(3),
ADD COLUMN "callEventId" TEXT,
ADD COLUMN "callStatus" TEXT;
