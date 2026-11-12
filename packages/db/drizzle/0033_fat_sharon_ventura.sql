CREATE TABLE "data_request_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"request_type" varchar(16) NOT NULL,
	"status" varchar(32) DEFAULT 'VERIFIED' NOT NULL,
	"verification_reference" varchar(128) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"target_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"block_reason" varchar(32),
	"last_reviewed_at" timestamp with time zone,
	"last_reviewed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_request_cases_org_idempotency_uq" UNIQUE("organisation_id","idempotency_key"),
	CONSTRAINT "data_request_cases_type_ck" CHECK ("data_request_cases"."request_type" in ('EXPORT', 'DELETION')),
	CONSTRAINT "data_request_cases_status_ck" CHECK ("data_request_cases"."status" in ('VERIFIED', 'IN_REVIEW', 'BLOCKED', 'MANUAL_REVIEW_REQUIRED', 'COMPLETED')),
	CONSTRAINT "data_request_cases_target_ck" CHECK ("data_request_cases"."target_at" = "data_request_cases"."verified_at" + interval '14 days'),
	CONSTRAINT "data_request_cases_version_ck" CHECK ("data_request_cases"."version" >= 0),
	CONSTRAINT "data_request_cases_block_reason_ck" CHECK ("data_request_cases"."block_reason" is null or "data_request_cases"."block_reason" in ('LEGAL_HOLD', 'RETENTION_PERIOD_ACTIVE', 'BACKUP_AGEING_UNVERIFIED')),
	CONSTRAINT "data_request_cases_blocked_ck" CHECK (("data_request_cases"."status" = 'BLOCKED' and "data_request_cases"."block_reason" is not null) or ("data_request_cases"."status" <> 'BLOCKED' and "data_request_cases"."block_reason" is null)),
	CONSTRAINT "data_request_cases_completed_ck" CHECK (("data_request_cases"."status" = 'COMPLETED' and "data_request_cases"."completed_at" is not null) or ("data_request_cases"."status" <> 'COMPLETED' and "data_request_cases"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "deletion_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "backup_expiry_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_cases" ADD COLUMN "backup_expiry_evidence_reference" varchar(128);--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD CONSTRAINT "data_request_cases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_request_cases" ADD CONSTRAINT "data_request_cases_last_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("last_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_request_cases_target_idx" ON "data_request_cases" USING btree ("status","target_at");--> statement-breakpoint
CREATE INDEX "data_request_cases_org_status_idx" ON "data_request_cases" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "retention_cases_deletion_eligibility_idx" ON "retention_cases" USING btree ("status","deletion_eligible_at");--> statement-breakpoint
ALTER TABLE "retention_cases" ADD CONSTRAINT "retention_cases_backup_evidence_ck" CHECK (("retention_cases"."backup_expiry_verified_at" is null and "retention_cases"."backup_expiry_evidence_reference" is null) or ("retention_cases"."backup_expiry_verified_at" is not null and "retention_cases"."backup_expiry_evidence_reference" is not null));