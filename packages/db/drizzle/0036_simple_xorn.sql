CREATE TABLE "retention_operation_receipts" (
	"organisation_id" uuid NOT NULL,
	"operation_id" varchar(128) NOT NULL,
	"operation_type" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"input_hash" char(64) NOT NULL,
	"result_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_operation_receipts_pk" PRIMARY KEY("organisation_id","operation_id"),
	CONSTRAINT "retention_operation_receipts_type_ck" CHECK ("retention_operation_receipts"."operation_type" in ('REVIEW_DATA_REQUEST', 'VERIFY_BACKUP_AGEING', 'COMPLETE_EXPORT_REQUEST')),
	CONSTRAINT "retention_operation_receipts_hash_ck" CHECK ("retention_operation_receipts"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "retention_operation_receipts_version_ck" CHECK ("retention_operation_receipts"."result_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_request_cases" DROP CONSTRAINT "data_request_cases_completed_ck";--> statement-breakpoint
ALTER TABLE "retention_cases" DROP CONSTRAINT "retention_cases_backup_evidence_ck";--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD COLUMN "retention_closure_episode_id" uuid;--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD COLUMN "completed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD COLUMN "completion_reference" varchar(128);--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD COLUMN "completion_export_audit_event_id" uuid;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "closure_episode_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "closure_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "closure_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "backup_expiry_closure_episode_id" uuid;--> statement-breakpoint
UPDATE "retention_cases"
   SET "closure_effective_at" = coalesce(
     "deletion_eligible_at" - interval '5 years',
     "disconnected_at"
   );--> statement-breakpoint
UPDATE "retention_cases"
   SET "backup_expiry_verified_at" = null,
       "backup_expiry_evidence_reference" = null
 WHERE "backup_expiry_verified_at" is not null
   AND (
     "deletion_eligible_at" is null
     OR "backup_expiry_verified_at" < "deletion_eligible_at"
   );--> statement-breakpoint
UPDATE "retention_cases"
   SET "backup_expiry_closure_episode_id" = "closure_episode_id"
 WHERE "backup_expiry_verified_at" is not null;--> statement-breakpoint
UPDATE "data_request_cases" request
   SET "retention_closure_episode_id" = retention."closure_episode_id"
  FROM "retention_cases" retention
 WHERE retention."organisation_id" = request."organisation_id";--> statement-breakpoint
UPDATE "data_request_cases"
   SET "status" = CASE
         WHEN "request_type" = 'EXPORT' THEN 'IN_REVIEW'
         ELSE 'MANUAL_REVIEW_REQUIRED'
       END,
       "block_reason" = null,
       "completed_at" = null,
       "version" = "version" + 1,
       "updated_at" = now()
 WHERE "status" = 'COMPLETED';--> statement-breakpoint
ALTER TABLE "retention_cases" ALTER COLUMN "closure_effective_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_operation_receipts" ADD CONSTRAINT "retention_operation_receipts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_operation_receipts_entity_idx" ON "retention_operation_receipts" USING btree ("organisation_id","entity_id","created_at");--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD CONSTRAINT "data_request_cases_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD CONSTRAINT "data_request_cases_completed_ck" CHECK (("data_request_cases"."status" = 'COMPLETED' and "data_request_cases"."completed_at" is not null and "data_request_cases"."completed_by_user_id" is not null and "data_request_cases"."completion_reference" is not null and ("data_request_cases"."request_type" <> 'EXPORT' or "data_request_cases"."completion_export_audit_event_id" is not null)) or ("data_request_cases"."status" <> 'COMPLETED' and "data_request_cases"."completed_at" is null and "data_request_cases"."completed_by_user_id" is null and "data_request_cases"."completion_reference" is null and "data_request_cases"."completion_export_audit_event_id" is null));--> statement-breakpoint
ALTER TABLE "retention_cases" ADD CONSTRAINT "retention_cases_closure_version_ck" CHECK ("retention_cases"."closure_version" >= 1);--> statement-breakpoint
ALTER TABLE "retention_cases" ADD CONSTRAINT "retention_cases_deletion_eligibility_ck" CHECK ("retention_cases"."deletion_eligible_at" is null or "retention_cases"."deletion_eligible_at" >= "retention_cases"."closure_effective_at");--> statement-breakpoint
ALTER TABLE "retention_cases" ADD CONSTRAINT "retention_cases_backup_evidence_ck" CHECK (("retention_cases"."backup_expiry_verified_at" is null and "retention_cases"."backup_expiry_evidence_reference" is null and "retention_cases"."backup_expiry_closure_episode_id" is null) or ("retention_cases"."backup_expiry_verified_at" is not null and "retention_cases"."backup_expiry_evidence_reference" is not null and "retention_cases"."backup_expiry_closure_episode_id" = "retention_cases"."closure_episode_id" and "retention_cases"."deletion_eligible_at" is not null and "retention_cases"."backup_expiry_verified_at" >= "retention_cases"."deletion_eligible_at"));
