CREATE TABLE "billing_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"provider_object_type" varchar(16) NOT NULL,
	"provider_object_id" varchar(128) NOT NULL,
	"provider_status" varchar(64) NOT NULL,
	"stripe_subscription_id" varchar(128) NOT NULL,
	"subscription_relation" varchar(16) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"blocks_sending" boolean DEFAULT false NOT NULL,
	"latest_provider_event_id" varchar(128) NOT NULL,
	"latest_provider_event_created_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_cases_org_id_uq" UNIQUE("organisation_id","id"),
	CONSTRAINT "billing_cases_kind_ck" CHECK ("billing_cases"."kind" in ('PAYMENT_FAILURE', 'REFUND', 'DISPUTE')),
	CONSTRAINT "billing_cases_status_ck" CHECK ("billing_cases"."status" in ('OPEN', 'RESOLVED', 'REVIEW_REQUIRED')),
	CONSTRAINT "billing_cases_provider_object_type_ck" CHECK ("billing_cases"."provider_object_type" in ('INVOICE', 'CHARGE', 'DISPUTE')),
	CONSTRAINT "billing_cases_subscription_relation_ck" CHECK ("billing_cases"."subscription_relation" in ('CURRENT', 'RETIRED')),
	CONSTRAINT "billing_cases_amount_ck" CHECK ("billing_cases"."amount_minor" >= 0),
	CONSTRAINT "billing_cases_currency_ck" CHECK ("billing_cases"."currency" = 'aud'),
	CONSTRAINT "billing_cases_resolution_ck" CHECK (("billing_cases"."status" = 'RESOLVED' and "billing_cases"."resolved_at" is not null) or ("billing_cases"."status" <> 'RESOLVED' and "billing_cases"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "transactional_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"billing_case_id" uuid NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"template" varchar(32) NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"render_data" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" varchar(16) DEFAULT 'HELD' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_failure_code" varchar(64),
	"last_attempted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactional_email_outbox_template_ck" CHECK ("transactional_email_outbox"."template" in ('PAYMENT_FAILED', 'PAYMENT_RECOVERED', 'REFUND_RECORDED', 'DISPUTE_OPENED', 'DISPUTE_CLOSED')),
	CONSTRAINT "transactional_email_outbox_status_ck" CHECK ("transactional_email_outbox"."status" in ('HELD', 'PENDING', 'SENT', 'FAILED')),
	CONSTRAINT "transactional_email_outbox_template_version_ck" CHECK ("transactional_email_outbox"."template_version" >= 1),
	CONSTRAINT "transactional_email_outbox_attempts_ck" CHECK ("transactional_email_outbox"."attempts" >= 0),
	CONSTRAINT "transactional_email_outbox_render_data_ck" CHECK (jsonb_typeof("transactional_email_outbox"."render_data") = 'object'),
	CONSTRAINT "transactional_email_outbox_sent_ck" CHECK (("transactional_email_outbox"."status" = 'SENT' and "transactional_email_outbox"."sent_at" is not null) or ("transactional_email_outbox"."status" <> 'SENT' and "transactional_email_outbox"."sent_at" is null))
);
--> statement-breakpoint
ALTER TABLE "billing_cases" ADD CONSTRAINT "billing_cases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_email_outbox" ADD CONSTRAINT "transactional_email_outbox_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_email_outbox" ADD CONSTRAINT "transactional_email_outbox_org_case_fk" FOREIGN KEY ("organisation_id","billing_case_id") REFERENCES "public"."billing_cases"("organisation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_cases_org_kind_provider_uq" ON "billing_cases" USING btree ("organisation_id","kind","provider_object_type","provider_object_id");--> statement-breakpoint
CREATE INDEX "billing_cases_org_status_created_idx" ON "billing_cases" USING btree ("organisation_id","status","created_at");--> statement-breakpoint
CREATE INDEX "billing_cases_blocking_status_idx" ON "billing_cases" USING btree ("blocks_sending","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactional_email_outbox_org_idempotency_uq" ON "transactional_email_outbox" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "transactional_email_outbox_org_status_created_idx" ON "transactional_email_outbox" USING btree ("organisation_id","status","created_at");--> statement-breakpoint
CREATE INDEX "transactional_email_outbox_case_created_idx" ON "transactional_email_outbox" USING btree ("billing_case_id","created_at");