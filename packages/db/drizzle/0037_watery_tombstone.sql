ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_state_ck";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_initial_card_evidence_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_pkey";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "stripe_subscription_id" varchar(128);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_attempt_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_checkout_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "initial_card_stripe_subscription_id" varchar(128);--> statement-breakpoint
UPDATE "subscriptions"
SET "initial_card_stripe_subscription_id" = "stripe_subscription_id"
WHERE "initial_card_invoice_id" IS NOT NULL
  AND "initial_card_payment_succeeded_at" IS NOT NULL
  AND "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
UPDATE "direct_debit_requests" AS d
SET "stripe_subscription_id" = s."stripe_subscription_id"
FROM "subscriptions" AS s
WHERE s."organisation_id" = d."organisation_id"
  AND s."stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
UPDATE "direct_debit_requests"
SET
  "setup_attempt_version" = 1,
  "setup_session_expires_at" = CASE
    WHEN "status" = 'SETUP_PENDING' THEN now()
    ELSE COALESCE("mandate_confirmed_at", "updated_at", now())
  END,
  "setup_checkout_completed_at" = CASE
    WHEN "status" IN ('MANDATE_CONFIRMED', 'ACTIVE')
      THEN COALESCE("mandate_confirmed_at", "updated_at", now())
    ELSE NULL
  END
WHERE "status" <> 'REQUESTED';--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ALTER COLUMN "stripe_subscription_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_pkey" PRIMARY KEY ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_org_subscription_uq" ON "direct_debit_requests" USING btree ("organisation_id","stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_setup_version_ck" CHECK ("direct_debit_requests"."setup_attempt_version" >= 0);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_state_ck" CHECK ((
        "direct_debit_requests"."status" = 'REQUESTED' and
        "direct_debit_requests"."setup_attempt_version" = 0 and
        "direct_debit_requests"."setup_session_id" is null and
        "direct_debit_requests"."setup_session_expires_at" is null and
        "direct_debit_requests"."setup_checkout_completed_at" is null and
        "direct_debit_requests"."setup_intent_id" is null and
        "direct_debit_requests"."stripe_payment_method_id" is null and
        "direct_debit_requests"."stripe_mandate_id" is null and
        "direct_debit_requests"."mandate_confirmed_at" is null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'SETUP_PENDING' and
        "direct_debit_requests"."setup_attempt_version" > 0 and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_session_expires_at" is not null and
        (("direct_debit_requests"."setup_intent_id" is null and "direct_debit_requests"."setup_checkout_completed_at" is null) or ("direct_debit_requests"."setup_intent_id" is not null and "direct_debit_requests"."setup_checkout_completed_at" is not null)) and
        "direct_debit_requests"."stripe_payment_method_id" is null and
        "direct_debit_requests"."stripe_mandate_id" is null and
        "direct_debit_requests"."mandate_confirmed_at" is null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'MANDATE_CONFIRMED' and
        "direct_debit_requests"."setup_attempt_version" > 0 and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_session_expires_at" is not null and
        "direct_debit_requests"."setup_checkout_completed_at" is not null and
        "direct_debit_requests"."setup_intent_id" is not null and
        "direct_debit_requests"."stripe_payment_method_id" is not null and
        "direct_debit_requests"."stripe_mandate_id" is not null and
        "direct_debit_requests"."mandate_confirmed_at" is not null and
        "direct_debit_requests"."activated_by_user_id" is null and
        "direct_debit_requests"."activated_at" is null
      ) or (
        "direct_debit_requests"."status" = 'ACTIVE' and
        "direct_debit_requests"."setup_attempt_version" > 0 and
        "direct_debit_requests"."setup_session_id" is not null and
        "direct_debit_requests"."setup_session_expires_at" is not null and
        "direct_debit_requests"."setup_checkout_completed_at" is not null and
        "direct_debit_requests"."setup_intent_id" is not null and
        "direct_debit_requests"."stripe_payment_method_id" is not null and
        "direct_debit_requests"."stripe_mandate_id" is not null and
        "direct_debit_requests"."mandate_confirmed_at" is not null and
        "direct_debit_requests"."activated_by_user_id" is not null and
        "direct_debit_requests"."activated_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_initial_card_evidence_ck" CHECK (("subscriptions"."initial_card_stripe_subscription_id" is null and "subscriptions"."initial_card_invoice_id" is null and "subscriptions"."initial_card_payment_succeeded_at" is null) or ("subscriptions"."initial_card_stripe_subscription_id" is not null and "subscriptions"."initial_card_invoice_id" is not null and "subscriptions"."initial_card_payment_succeeded_at" is not null));
