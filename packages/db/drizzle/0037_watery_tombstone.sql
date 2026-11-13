ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_state_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_status_ck";--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_initial_card_evidence_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_pkey";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "stripe_subscription_id" varchar(128);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "legacy_status" varchar(24);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_attempt_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "setup_checkout_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "initial_card_stripe_subscription_id" varchar(128);--> statement-breakpoint
-- Legacy Checkout events record the organisation and time only. Bind the
-- card payment only when its event is the sole latest applied Checkout and
-- the organisation has no record of a retired subscription.
UPDATE "subscriptions" AS s
SET "initial_card_stripe_subscription_id" = s."stripe_subscription_id"
WHERE s."initial_card_invoice_id" IS NOT NULL
  AND s."initial_card_payment_succeeded_at" IS NOT NULL
  AND s."stripe_subscription_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "retired_stripe_subscriptions" AS retired
    WHERE retired."organisation_id" = s."organisation_id"
  )
  AND EXISTS (
    SELECT 1
    FROM "subscription_events" AS evidence
    WHERE evidence."organisation_id" = s."organisation_id"
      AND evidence."event_type" = 'checkout.session.completed'
      AND evidence."outcome" = 'APPLIED'
      AND evidence."stripe_event_created_at" >= s."initial_card_payment_succeeded_at"
    HAVING count(*) = 1
      AND min(evidence."stripe_event_created_at") = s."initial_card_payment_succeeded_at"
  );--> statement-breakpoint
UPDATE "subscriptions"
SET
  "initial_card_stripe_subscription_id" = NULL,
  "initial_card_invoice_id" = NULL,
  "initial_card_payment_succeeded_at" = NULL
WHERE "initial_card_stripe_subscription_id" IS NULL
  AND (
    "initial_card_invoice_id" IS NOT NULL OR
    "initial_card_payment_succeeded_at" IS NOT NULL
  );--> statement-breakpoint
-- No legacy request stored a verified Checkout-session-to-SetupIntent
-- binding. Preserve its evidence outside the current subscription episode.
UPDATE "direct_debit_requests"
SET "legacy_status" = "status", "status" = 'LEGACY_UNBOUND';--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_pkey" PRIMARY KEY ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_debit_requests_org_subscription_uq" ON "direct_debit_requests" USING btree ("organisation_id","stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_status_ck" CHECK ("direct_debit_requests"."status" in ('REQUESTED', 'SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE', 'LEGACY_UNBOUND'));--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_episode_ck" CHECK ((
        "direct_debit_requests"."status" = 'LEGACY_UNBOUND' and
        "direct_debit_requests"."stripe_subscription_id" is null and
        "direct_debit_requests"."legacy_status" is not null and
        "direct_debit_requests"."legacy_status" in ('REQUESTED', 'SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE')
      ) or (
        "direct_debit_requests"."status" <> 'LEGACY_UNBOUND' and
        "direct_debit_requests"."stripe_subscription_id" is not null and
        "direct_debit_requests"."legacy_status" is null
      ));--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_setup_version_ck" CHECK ("direct_debit_requests"."setup_attempt_version" >= 0);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_state_ck" CHECK ((
        "direct_debit_requests"."status" = 'LEGACY_UNBOUND' and
        "direct_debit_requests"."setup_attempt_version" = 0 and
        "direct_debit_requests"."setup_session_expires_at" is null and
        "direct_debit_requests"."setup_checkout_completed_at" is null
      ) or (
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
