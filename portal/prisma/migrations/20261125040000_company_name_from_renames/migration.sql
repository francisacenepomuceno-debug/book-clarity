-- Before company names had their own field, renaming a client or separating a company stored the company in
-- "name". Move those into "companyName"; "name" goes back to the contact person on the next Stripe sync.
UPDATE "Client" SET "companyName" = "name"
WHERE "companyName" IS NULL
  AND "id" IN (SELECT "entityId" FROM "AuditLog" WHERE "entity" = 'Client' AND "action" IN ('client_renamed', 'company_separated'));
