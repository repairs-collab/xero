-- Published migration 0037 copied the then-current Stripe subscription ID
-- onto historical card-payment fields. Event type and timestamp alone cannot
-- prove that those values belong to the same billing episode. Preserve every
-- quarantined value in the audit log, and retain current eligibility only when
-- a validated Checkout attempt binds the Session, customer and subscription.
WITH unsafe_evidence AS MATERIALIZED (
  SELECT
    s."organisation_id",
    s."stripe_customer_id",
    s."initial_card_stripe_subscription_id",
    s."initial_card_invoice_id",
    s."initial_card_payment_succeeded_at"
  FROM "subscriptions" AS s
  WHERE s."initial_card_stripe_subscription_id" IS NOT NULL
    AND s."initial_card_invoice_id" IS NOT NULL
    AND s."initial_card_payment_succeeded_at" IS NOT NULL
    AND (
      s."stripe_customer_id" IS NULL OR
      s."stripe_subscription_id" IS NULL OR
      s."initial_card_stripe_subscription_id" <> s."stripe_subscription_id" OR
      EXISTS (
        SELECT 1
        FROM "retired_stripe_subscriptions" AS retired
        WHERE retired."organisation_id" = s."organisation_id"
          AND retired."stripe_subscription_id" = s."stripe_subscription_id"
      ) OR
      NOT EXISTS (
        SELECT 1
        FROM "solo_checkout_attempts" AS attempt
        WHERE attempt."organisation_id" = s."organisation_id"
          AND attempt."stripe_session_status" = 'complete'
          AND attempt."stripe_session_id" IS NOT NULL
          AND attempt."stripe_customer_id" = s."stripe_customer_id"
          AND attempt."stripe_subscription_id" = s."stripe_subscription_id"
          AND attempt."stripe_subscription_id" = s."initial_card_stripe_subscription_id"
          AND attempt."created_at" <= s."initial_card_payment_succeeded_at"
      )
    )
  FOR UPDATE
), quarantined_audit AS (
  INSERT INTO "audit_events" (
    "organisation_id",
    "event_type",
    "entity_type",
    "entity_id",
    "correlation_id",
    "before_value",
    "after_value",
    "occurred_at"
  )
  SELECT
    unsafe."organisation_id",
    'INITIAL_CARD_EVIDENCE_QUARANTINED',
    'SUBSCRIPTION',
    unsafe."organisation_id"::text,
    'migration:0042',
    jsonb_build_object(
      'stripeCustomerId', unsafe."stripe_customer_id",
      'stripeSubscriptionId', unsafe."initial_card_stripe_subscription_id",
      'invoiceId', unsafe."initial_card_invoice_id",
      'paymentSucceededAt', unsafe."initial_card_payment_succeeded_at"
    ),
    jsonb_build_object(
      'reason', 'CHECKOUT_EPISODE_IDENTITY_NOT_PROVEN',
      'eligibleForDirectDebit', false
    ),
    now()
  FROM unsafe_evidence AS unsafe
  RETURNING "organisation_id"
)
UPDATE "subscriptions" AS s
SET
  "legacy_initial_card_stripe_subscription_id" = COALESCE(
    s."legacy_initial_card_stripe_subscription_id",
    s."initial_card_stripe_subscription_id"
  ),
  "legacy_initial_card_invoice_id" = COALESCE(
    s."legacy_initial_card_invoice_id",
    s."initial_card_invoice_id"
  ),
  "legacy_initial_card_payment_succeeded_at" = COALESCE(
    s."legacy_initial_card_payment_succeeded_at",
    s."initial_card_payment_succeeded_at"
  ),
  "initial_card_stripe_subscription_id" = NULL,
  "initial_card_invoice_id" = NULL,
  "initial_card_payment_succeeded_at" = NULL
FROM unsafe_evidence AS unsafe
WHERE s."organisation_id" = unsafe."organisation_id"
  AND EXISTS (
    SELECT 1
    FROM quarantined_audit AS audit
    WHERE audit."organisation_id" = unsafe."organisation_id"
  );
