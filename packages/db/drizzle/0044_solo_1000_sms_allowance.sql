ALTER TABLE "sms_allowance_settings"
ALTER COLUMN "included_parts" SET DEFAULT 1000;
--> statement-breakpoint
UPDATE "sms_allowance_settings" AS settings
SET
  "included_parts" = 1000,
  "updated_at" = now()
FROM "organisations" AS organisation
WHERE settings."organisation_id" = organisation."id"
  AND organisation."edition" = 'SOLO'
  AND settings."included_parts" = 2000
  AND NOT EXISTS (
    SELECT 1
    FROM "platform_admin_audit_events" AS audit
    WHERE audit."target_organisation_id" = settings."organisation_id"
      AND audit."event_type" = 'SMS_ALLOWANCE_UPDATED'
  );
