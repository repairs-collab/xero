CREATE TABLE "retention_cases" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"source" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'SCHEDULED' NOT NULL,
	"disconnected_at" timestamp with time zone NOT NULL,
	"review_after" timestamp with time zone NOT NULL,
	"review_attempts" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"last_review_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_cases_source_ck" CHECK ("retention_cases"."source" in ('TRIAL_EXPIRED', 'SUBSCRIPTION_CANCELLED', 'CUSTOMER_REQUEST')),
	CONSTRAINT "retention_cases_status_ck" CHECK ("retention_cases"."status" in ('SCHEDULED', 'REVIEW_REQUIRED', 'LEGAL_HOLD', 'COMPLETED')),
	CONSTRAINT "retention_cases_review_after_ck" CHECK ("retention_cases"."review_after" > "retention_cases"."disconnected_at"),
	CONSTRAINT "retention_cases_attempts_ck" CHECK ("retention_cases"."review_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "retention_cases" ADD CONSTRAINT "retention_cases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_cases_due_idx" ON "retention_cases" USING btree ("status","review_after");
--> statement-breakpoint
INSERT INTO "retention_cases" (
	"organisation_id",
	"source",
	"status",
	"disconnected_at",
	"review_after",
	"created_at",
	"updated_at"
)
SELECT
	"organisation_id",
	CASE
		WHEN "event_type" = 'TRIAL_RETENTION_SCHEDULED' THEN 'TRIAL_EXPIRED'
		ELSE 'SUBSCRIPTION_CANCELLED'
	END,
	'SCHEDULED',
	("after_value" ->> 'disconnectedAt')::timestamptz,
	("after_value" ->> 'retentionDeadline')::timestamptz,
	"occurred_at",
	"occurred_at"
FROM "audit_events"
WHERE "event_type" IN (
	'TRIAL_RETENTION_SCHEDULED',
	'SUBSCRIPTION_RETENTION_SCHEDULED'
)
	AND "after_value" ->> 'disconnectedAt' IS NOT NULL
	AND "after_value" ->> 'retentionDeadline' IS NOT NULL
ON CONFLICT ("organisation_id") DO NOTHING;
