CREATE TABLE "solo_checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"predecessor_stripe_subscription_id" varchar(128),
	"requested_stripe_customer_id" varchar(128),
	"billing_cadence" varchar(16) NOT NULL,
	"initiating_user_id" uuid NOT NULL,
	"customer_email" text,
	"price_id" varchar(128) NOT NULL,
	"automatic_tax_enabled" boolean NOT NULL,
	"public_origin" text NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stripe_session_id" varchar(128),
	"stripe_session_status" varchar(16),
	"stripe_customer_id" varchar(128),
	"stripe_subscription_id" varchar(128),
	"terminal_lifecycle_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "solo_checkout_attempts_cadence_ck" CHECK ("solo_checkout_attempts"."billing_cadence" in ('MONTHLY', 'ANNUAL')),
	CONSTRAINT "solo_checkout_attempts_request_customer_ck" CHECK (("solo_checkout_attempts"."requested_stripe_customer_id" is null) <> ("solo_checkout_attempts"."customer_email" is null)),
	CONSTRAINT "solo_checkout_attempts_session_ck" CHECK (
      ("solo_checkout_attempts"."stripe_session_id" is null) = ("solo_checkout_attempts"."stripe_session_status" is null)
      and ("solo_checkout_attempts"."stripe_session_status" is null or "solo_checkout_attempts"."stripe_session_status" in ('open', 'complete', 'expired'))
    ),
	CONSTRAINT "solo_checkout_attempts_subscription_ck" CHECK (
      ("solo_checkout_attempts"."stripe_subscription_id" is null or "solo_checkout_attempts"."stripe_customer_id" is not null)
      and ("solo_checkout_attempts"."stripe_session_status" is distinct from 'complete' or "solo_checkout_attempts"."stripe_subscription_id" is not null)
      and ("solo_checkout_attempts"."terminal_lifecycle_at" is null or "solo_checkout_attempts"."stripe_subscription_id" is not null)
    ),
	CONSTRAINT "solo_checkout_attempts_resolved_ck" CHECK (
      "solo_checkout_attempts"."resolved_at" is null or (
        "solo_checkout_attempts"."stripe_session_status" is not null and "solo_checkout_attempts"."stripe_session_status" in ('complete', 'expired')
        and ("solo_checkout_attempts"."stripe_subscription_id" is null or "solo_checkout_attempts"."terminal_lifecycle_at" is not null)
      )
    )
);
--> statement-breakpoint
ALTER TABLE "solo_checkout_attempts" ADD CONSTRAINT "solo_checkout_attempts_organisation_id_subscriptions_organisation_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."subscriptions"("organisation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "solo_checkout_attempts_unresolved_org_uq" ON "solo_checkout_attempts" USING btree ("organisation_id") WHERE "solo_checkout_attempts"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "solo_checkout_attempts_session_uq" ON "solo_checkout_attempts" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "solo_checkout_attempts_subscription_uq" ON "solo_checkout_attempts" USING btree ("stripe_subscription_id");