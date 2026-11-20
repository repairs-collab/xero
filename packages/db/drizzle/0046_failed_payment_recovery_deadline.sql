ALTER TABLE "billing_cases" ADD COLUMN "recovery_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "suspension_source" varchar(24);--> statement-breakpoint
UPDATE "organisations"
SET "suspension_source" = 'OWNER'
WHERE "platform_status" = 'SUSPENDED' AND "suspension_source" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "organisations_set_suspension_source"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."platform_status" = 'ACTIVE' THEN
    NEW."suspension_source" := NULL;
  ELSIF NEW."suspension_source" IS NULL THEN
    NEW."suspension_source" := 'OWNER';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "organisations_suspension_source_compat_trg"
BEFORE INSERT OR UPDATE ON "organisations"
FOR EACH ROW
EXECUTE FUNCTION "organisations_set_suspension_source"();--> statement-breakpoint
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_platform_suspension_metadata_ck";--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_platform_suspension_metadata_ck" CHECK (("platform_status" = 'ACTIVE' and "suspended_at" is null and "suspension_reason" is null and "suspension_source" is null)
          or ("platform_status" = 'SUSPENDED' and "suspended_at" is not null and nullif(btrim("suspension_reason"), '') is not null and "suspension_source" in ('OWNER', 'PAYMENT_FAILURE', 'BILLING_REVIEW')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "billing_cases_set_recovery_deadline"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" = 'PAYMENT_FAILURE' AND NEW."recovery_ends_at" IS NULL THEN
    NEW."recovery_ends_at" := NEW."opened_at" + interval '30 days';
  ELSIF NEW."kind" <> 'PAYMENT_FAILURE' THEN
    NEW."recovery_ends_at" := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "billing_cases_recovery_deadline_compat_trg"
BEFORE INSERT OR UPDATE ON "billing_cases"
FOR EACH ROW
EXECUTE FUNCTION "billing_cases_set_recovery_deadline"();--> statement-breakpoint
UPDATE "billing_cases"
SET "recovery_ends_at" = "opened_at" + interval '30 days'
WHERE "kind" = 'PAYMENT_FAILURE' AND "recovery_ends_at" IS NULL;--> statement-breakpoint
ALTER TABLE "billing_cases" ADD CONSTRAINT "billing_cases_recovery_deadline_ck" CHECK (("kind" = 'PAYMENT_FAILURE' and "recovery_ends_at" is not null) or ("kind" <> 'PAYMENT_FAILURE' and "recovery_ends_at" is null));--> statement-breakpoint
CREATE INDEX "billing_cases_recovery_due_idx" ON "billing_cases" USING btree ("status","recovery_ends_at","id");
