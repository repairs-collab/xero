ALTER TABLE "direct_debit_requests" DROP CONSTRAINT IF EXISTS "direct_debit_requests_status_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT IF EXISTS "direct_debit_requests_state_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT IF EXISTS "direct_debit_requests_episode_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT IF EXISTS "direct_debit_requests_reconciliation_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" DROP CONSTRAINT IF EXISTS "direct_debit_requests_provider_reconciled_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ALTER COLUMN "stripe_subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN IF NOT EXISTS "legacy_status" varchar(24);--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN IF NOT EXISTS "provider_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN IF NOT EXISTS "provider_reconciled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN IF NOT EXISTS "provider_reconciliation_outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "legacy_initial_card_stripe_subscription_id" varchar(128);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "legacy_initial_card_invoice_id" varchar(128);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "legacy_initial_card_payment_succeeded_at" timestamp with time zone;--> statement-breakpoint
-- Published migration 0037 inferred a current Stripe subscription for every
-- historical direct-debit row and fabricated setup timing fields. Preserve
-- the opaque provider identifiers as history, but quarantine the inferred
-- episode until the platform owner records a safe provider outcome.
UPDATE "direct_debit_requests"
SET
  "legacy_status" = "status",
  "status" = 'LEGACY_UNBOUND',
  "stripe_subscription_id" = NULL,
  "setup_attempt_version" = 0,
  "setup_session_expires_at" = NULL,
  "setup_checkout_completed_at" = NULL,
  "provider_reconciled_at" = NULL,
  "provider_reconciled_by_user_id" = NULL,
  "provider_reconciliation_outcome" = NULL
WHERE "status" <> 'LEGACY_UNBOUND';--> statement-breakpoint
-- A pre-release candidate used free-text acknowledgement. It cannot prove a
-- safe resolved outcome, so keep those rows fail-closed if this migration is
-- applied to such an environment.
UPDATE "direct_debit_requests"
SET
  "provider_reconciled_at" = NULL,
  "provider_reconciled_by_user_id" = NULL
WHERE "status" = 'LEGACY_UNBOUND'
  AND "provider_reconciliation_outcome" IS NULL;--> statement-breakpoint
-- Keep ambiguous initial-card values as explicit historical evidence while
-- removing them from current-episode eligibility. Only the sole, latest
-- applied Checkout with no retired subscription remains current evidence.
UPDATE "subscriptions" AS s
SET
  "legacy_initial_card_stripe_subscription_id" = s."initial_card_stripe_subscription_id",
  "legacy_initial_card_invoice_id" = s."initial_card_invoice_id",
  "legacy_initial_card_payment_succeeded_at" = s."initial_card_payment_succeeded_at",
  "initial_card_stripe_subscription_id" = NULL,
  "initial_card_invoice_id" = NULL,
  "initial_card_payment_succeeded_at" = NULL
WHERE s."initial_card_stripe_subscription_id" IS NOT NULL
  AND s."initial_card_invoice_id" IS NOT NULL
  AND s."initial_card_payment_succeeded_at" IS NOT NULL
  AND NOT (
    s."stripe_subscription_id" IS NOT NULL
    AND s."initial_card_stripe_subscription_id" = s."stripe_subscription_id"
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
    )
  );--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_provider_reconciled_by_user_id_users_id_fk" FOREIGN KEY ("provider_reconciled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_reconciliation_ck" CHECK ((
        "direct_debit_requests"."status" = 'LEGACY_UNBOUND' and (
          (
            "direct_debit_requests"."provider_reconciled_at" is null and
            "direct_debit_requests"."provider_reconciled_by_user_id" is null and
            "direct_debit_requests"."provider_reconciliation_outcome" is null
          ) or (
            "direct_debit_requests"."provider_reconciled_at" is not null and
            "direct_debit_requests"."provider_reconciled_by_user_id" is not null and
            "direct_debit_requests"."provider_reconciliation_outcome" is not null and
            "direct_debit_requests"."provider_reconciliation_outcome" in ('NO_LEGACY_DEFAULT', 'LEGACY_DEFAULT_REMOVED')
          )
        )
      ) or (
        "direct_debit_requests"."status" <> 'LEGACY_UNBOUND' and
        "direct_debit_requests"."provider_reconciled_at" is null and
        "direct_debit_requests"."provider_reconciled_by_user_id" is null and
        "direct_debit_requests"."provider_reconciliation_outcome" is null
      ));--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_status_ck" CHECK ("direct_debit_requests"."status" in ('REQUESTED', 'SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE', 'LEGACY_UNBOUND'));--> statement-breakpoint
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
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_legacy_initial_card_evidence_ck" CHECK (("subscriptions"."legacy_initial_card_stripe_subscription_id" is null and "subscriptions"."legacy_initial_card_invoice_id" is null and "subscriptions"."legacy_initial_card_payment_succeeded_at" is null) or ("subscriptions"."legacy_initial_card_stripe_subscription_id" is not null and "subscriptions"."legacy_initial_card_invoice_id" is not null and "subscriptions"."legacy_initial_card_payment_succeeded_at" is not null));
