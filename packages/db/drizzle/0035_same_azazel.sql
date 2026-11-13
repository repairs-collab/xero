CREATE TABLE "direct_debit_requests" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(24) DEFAULT 'REQUESTED' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"setup_session_id" varchar(128),
	"setup_intent_id" varchar(128),
	"stripe_payment_method_id" varchar(128),
	"stripe_mandate_id" varchar(128),
	"mandate_confirmed_at" timestamp with time zone,
	"activated_by_user_id" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_debit_requests_status_ck" CHECK ("direct_debit_requests"."status" in ('REQUESTED', 'SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE')),
	CONSTRAINT "direct_debit_requests_state_ck" CHECK ((
        "direct_debit_requests"."status" = 'REQUESTED' and
        "direct_debit_requests"."setup_session_id" is null and
        "direct_debit_requests"."setup_intent_id" is null and
        "direct_debit_requests"."stripe_payment_method_id" is null and
        "direct_debit_requests"."stripe_mandate_id" is null and
        "direct_debit_requests"."mandate_confirmed_at" is null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'SETUP_PENDING' and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_intent_id" is null and
        "direct_debit_requests"."stripe_payment_method_id" is null and
        "direct_debit_requests"."stripe_mandate_id" is null and
        "direct_debit_requests"."mandate_confirmed_at" is null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'MANDATE_CONFIRMED' and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_intent_id" is not null and
        "direct_debit_requests"."stripe_payment_method_id" is not null and
        "direct_debit_requests"."stripe_mandate_id" is not null and
        "direct_debit_requests"."mandate_confirmed_at" is not null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'ACTIVE' and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_intent_id" is not null and
        "direct_debit_requests"."stripe_payment_method_id" is not null and
        "direct_debit_requests"."stripe_mandate_id" is not null and
        "direct_debit_requests"."mandate_confirmed_at" is not null and
        "direct_debit_requests"."activated_by_user_id" is not null and
        "direct_debit_requests"."activated_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_cadence" varchar(16) DEFAULT 'MONTHLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "initial_card_invoice_id" varchar(128);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "initial_card_payment_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_organisation_id_subscriptions_organisation_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."subscriptions"("organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_setup_session_uq" ON "direct_debit_requests" USING btree ("setup_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_setup_intent_uq" ON "direct_debit_requests" USING btree ("setup_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_payment_method_uq" ON "direct_debit_requests" USING btree ("stripe_payment_method_id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_mandate_uq" ON "direct_debit_requests" USING btree ("stripe_mandate_id");--> statement-breakpoint
CREATE INDEX "direct_debit_requests_status_updated_idx" ON "direct_debit_requests" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_cadence_ck" CHECK ("subscriptions"."billing_cadence" in ('MONTHLY', 'ANNUAL'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_initial_card_evidence_ck" CHECK (("subscriptions"."initial_card_invoice_id" is null and "subscriptions"."initial_card_payment_succeeded_at" is null) or ("subscriptions"."initial_card_invoice_id" is not null and "subscriptions"."initial_card_payment_succeeded_at" is not null));