-- The client's company (business) name; "name" stays the contact person from Stripe.
ALTER TABLE "Client" ADD COLUMN "companyName" TEXT;
