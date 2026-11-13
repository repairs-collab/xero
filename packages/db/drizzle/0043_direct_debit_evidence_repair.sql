-- 0042 treated a mutable Checkout-attempt row and its created_at value as
-- proof of the invoice/customer/subscription payment tuple. Historical rows do
-- not persist an immutable signed-webhook correlation containing that complete
-- tuple, so this append-only repair fails closed and requires fresh evidence.
WITH unsafe_evidence AS MATERIALIZED (
  SELECT
    s."organisation_id",
    s."stripe_customer_id",
    s."stripe_subscription_id",
    s."initial_card_stripe_subscription_id",
    s."initial_card_invoice_id",
    s."initial_card_payment_succeeded_at",
    EXISTS (
      SELECT 1
      FROM "retired_stripe_subscriptions" AS retired
      WHERE retired."stripe_subscription_id" = s."stripe_subscription_id"
    ) AS "subscription_id_is_globally_retired"
  FROM "subscriptions" AS s
  WHERE s."initial_card_stripe_subscription_id" IS NOT NULL
    AND s."initial_card_invoice_id" IS NOT NULL
    AND s."initial_card_payment_succeeded_at" IS NOT NULL
  FOR UPDATE
)
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
  'migration:0043',
  jsonb_build_object(
    'stripeCustomerId', unsafe."stripe_customer_id",
    'stripeSubscriptionId', unsafe."initial_card_stripe_subscription_id",
    'invoiceId', unsafe."initial_card_invoice_id",
    'paymentSucceededAt', unsafe."initial_card_payment_succeeded_at"
  ),
  jsonb_build_object(
    'reason', CASE
      WHEN unsafe."subscription_id_is_globally_retired"
        THEN 'RETIRED_SUBSCRIPTION_ID_REUSED'
      ELSE 'IMMUTABLE_CHECKOUT_PAYMENT_CORRELATION_NOT_PROVEN'
    END,
    'eligibleForDirectDebit', false
  ),
  now()
FROM unsafe_evidence AS unsafe;
--> statement-breakpoint
-- Preserve every advanced request as explicit legacy evidence before changing
-- it. The row remains visible to the Owner reconciliation workflow, while its
-- unresolved LEGACY_UNBOUND state blocks setup or activation from continuing.
WITH unsafe_requests AS MATERIALIZED (
  SELECT d.*
  FROM "direct_debit_requests" AS d
  WHERE d."status" IN ('SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE')
  FOR UPDATE OF d
)
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
  request."organisation_id",
  'DIRECT_DEBIT_EVIDENCE_QUARANTINED',
  'DIRECT_DEBIT_REQUEST',
  request."id"::text,
  'migration:0043',
  jsonb_build_object(
    'status', request."status",
    'stripeSubscriptionId', request."stripe_subscription_id",
    'setupAttemptVersion', request."setup_attempt_version",
    'setupSessionId', request."setup_session_id",
    'setupSessionExpiresAt', request."setup_session_expires_at",
    'setupCheckoutCompletedAt', request."setup_checkout_completed_at",
    'setupIntentId', request."setup_intent_id",
    'stripePaymentMethodId', request."stripe_payment_method_id",
    'stripeMandateId', request."stripe_mandate_id",
    'mandateConfirmedAt', request."mandate_confirmed_at",
    'activatedByUserId', request."activated_by_user_id",
    'activatedAt', request."activated_at"
  ),
  jsonb_build_object(
    'status', 'LEGACY_UNBOUND',
    'legacyStatus', request."status",
    'reason', 'INITIAL_CARD_EVIDENCE_QUARANTINED'
  ),
  now()
FROM unsafe_requests AS request;
--> statement-breakpoint
UPDATE "direct_debit_requests" AS request
SET
  "status" = 'LEGACY_UNBOUND',
  "legacy_status" = request."status",
  "stripe_subscription_id" = NULL,
  "setup_attempt_version" = 0,
  "setup_session_expires_at" = NULL,
  "setup_checkout_completed_at" = NULL,
  "provider_reconciled_at" = NULL,
  "provider_reconciled_by_user_id" = NULL,
  "provider_reconciliation_outcome" = NULL,
  "provider_reconciliation_reference" = NULL,
  "updated_at" = now()
WHERE request."status" IN ('SETUP_PENDING', 'MANDATE_CONFIRMED', 'ACTIVE');
--> statement-breakpoint
UPDATE "subscriptions" AS subscription
SET
  "legacy_initial_card_stripe_subscription_id" = COALESCE(
    subscription."legacy_initial_card_stripe_subscription_id",
    subscription."initial_card_stripe_subscription_id"
  ),
  "legacy_initial_card_invoice_id" = COALESCE(
    subscription."legacy_initial_card_invoice_id",
    subscription."initial_card_invoice_id"
  ),
  "legacy_initial_card_payment_succeeded_at" = COALESCE(
    subscription."legacy_initial_card_payment_succeeded_at",
    subscription."initial_card_payment_succeeded_at"
  ),
  "initial_card_stripe_subscription_id" = NULL,
  "initial_card_invoice_id" = NULL,
  "initial_card_payment_succeeded_at" = NULL,
  "updated_at" = now()
WHERE subscription."initial_card_stripe_subscription_id" IS NOT NULL
  AND subscription."initial_card_invoice_id" IS NOT NULL
  AND subscription."initial_card_payment_succeeded_at" IS NOT NULL;
--> statement-breakpoint
-- Enforce the decision at the database boundary. Existing REQUESTED rows may
-- remain for audit continuity, but cannot advance until a later signed webhook
-- establishes a fresh complete card-payment tuple for the current, globally
-- non-retired subscription episode.
CREATE OR REPLACE FUNCTION direct_debit_require_current_card_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'LEGACY_UNBOUND' AND NOT EXISTS (
    SELECT 1
    FROM subscriptions AS subscription
    WHERE subscription.organisation_id = NEW.organisation_id
      AND subscription.stripe_subscription_id = NEW.stripe_subscription_id
      AND subscription.initial_card_stripe_subscription_id =
        subscription.stripe_subscription_id
      AND subscription.initial_card_invoice_id IS NOT NULL
      AND subscription.initial_card_payment_succeeded_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM retired_stripe_subscriptions AS retired
        WHERE retired.stripe_subscription_id =
          subscription.stripe_subscription_id
      )
  ) THEN
    RAISE EXCEPTION 'Current immutable card-payment evidence is required for direct debit.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS direct_debit_require_current_card_evidence_trigger
  ON direct_debit_requests;
--> statement-breakpoint
CREATE TRIGGER direct_debit_require_current_card_evidence_trigger
BEFORE INSERT OR UPDATE ON direct_debit_requests
FOR EACH ROW EXECUTE FUNCTION direct_debit_require_current_card_evidence();
