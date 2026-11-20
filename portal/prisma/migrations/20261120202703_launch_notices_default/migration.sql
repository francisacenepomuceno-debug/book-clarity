-- Plan 6 turned client notices off by default until launch. A portal that was already sending notices
-- keeps sending: if any notice was sent before this update, record notices as on.
INSERT INTO "Setting" ("key", "value")
SELECT 'launch', '{"noticesOn": true, "checks": {}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "Notification" WHERE "status" = 'SENT')
ON CONFLICT ("key") DO NOTHING;
