CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_event_id" varchar(128) NOT NULL,
	"event_type" text NOT NULL,
	"stripe_event_created_at" timestamp with time zone NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_events_outcome_ck" CHECK ("subscription_events"."outcome" in ('APPLIED', 'IGNORED_OUT_OF_ORDER', 'REJECTED')),
	CONSTRAINT "subscription_events_payload_hash_ck" CHECK (length("subscription_events"."payload_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"stripe_customer_id" varchar(128),
	"stripe_subscription_id" varchar(128),
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_stripe_event_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_plan_code_ck" CHECK ("subscriptions"."plan_code" = 'SOLO_AU_2000'),
	CONSTRAINT "subscriptions_status_ck" CHECK ("subscriptions"."status" in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'INCOMPLETE')),
	CONSTRAINT "subscriptions_period_ck" CHECK (("subscriptions"."current_period_start" is null and "subscriptions"."current_period_end" is null) or ("subscriptions"."current_period_start" is not null and "subscriptions"."current_period_end" is not null and "subscriptions"."current_period_end" > "subscriptions"."current_period_start"))
);
--> statement-breakpoint
CREATE TABLE "organisation_onboarding" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"xero_connected_at" timestamp with time zone,
	"sync_reconciled_at" timestamp with time zone,
	"business_details_completed_at" timestamp with time zone,
	"admin_mobile_verified_at" timestamp with time zone,
	"test_sms_completed_at" timestamp with time zone,
	"sequence_reviewed_at" timestamp with time zone,
	"subscription_ready_at" timestamp with time zone,
	"reply_number_ready_at" timestamp with time zone,
	"completed_version" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_onboarding_version_ck" CHECK ("organisation_onboarding"."version" >= 1),
	CONSTRAINT "organisation_onboarding_completion_ck" CHECK (("organisation_onboarding"."completed_version" is null and "organisation_onboarding"."completed_at" is null) or ("organisation_onboarding"."completed_version" is not null and "organisation_onboarding"."completed_at" is not null and "organisation_onboarding"."completed_version" >= 1 and "organisation_onboarding"."completed_version" <= "organisation_onboarding"."version"))
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "edition" varchar(24) DEFAULT 'INTERNAL_LEGACY' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_onboarding" ADD CONSTRAINT "organisation_onboarding_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_events_stripe_event_uq" ON "subscription_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "subscription_events_org_created_idx" ON "subscription_events" USING btree ("organisation_id","stripe_event_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_customer_uq" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_uq" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_edition_ck" CHECK ("organisations"."edition" in ('INTERNAL_LEGACY', 'SOLO'));