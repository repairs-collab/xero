ALTER TABLE "direct_debit_requests" DROP CONSTRAINT "direct_debit_requests_reconciliation_ck";--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD COLUMN "provider_reconciliation_reference" varchar(384);--> statement-breakpoint
-- A pre-release 0038 acknowledgement did not identify the exact legacy row or
-- provider objects inspected. It cannot satisfy the stronger evidence
-- contract, so return it to the explicit fail-closed Owner workflow.
UPDATE "direct_debit_requests"
SET
  "provider_reconciled_at" = NULL,
  "provider_reconciled_by_user_id" = NULL,
  "provider_reconciliation_outcome" = NULL
WHERE "status" = 'LEGACY_UNBOUND'
  AND (
    "provider_reconciled_at" IS NOT NULL OR
    "provider_reconciled_by_user_id" IS NOT NULL OR
    "provider_reconciliation_outcome" IS NOT NULL
  );--> statement-breakpoint
-- Restore current first-card evidence that an earlier pre-release 0038 moved
-- to legacy storage only because setup-mode Checkout completions were counted
-- as subscription-card completions. The correlated setup audit is the signed
-- discriminator; ambiguous or replacement evidence remains quarantined.
UPDATE "subscriptions" AS s
SET
  "initial_card_stripe_subscription_id" = s."legacy_initial_card_stripe_subscription_id",
  "initial_card_invoice_id" = s."legacy_initial_card_invoice_id",
  "initial_card_payment_succeeded_at" = s."legacy_initial_card_payment_succeeded_at",
  "legacy_initial_card_stripe_subscription_id" = NULL,
  "legacy_initial_card_invoice_id" = NULL,
  "legacy_initial_card_payment_succeeded_at" = NULL
WHERE s."initial_card_stripe_subscription_id" IS NULL
  AND s."initial_card_invoice_id" IS NULL
  AND s."initial_card_payment_succeeded_at" IS NULL
  AND s."legacy_initial_card_stripe_subscription_id" IS NOT NULL
  AND s."legacy_initial_card_invoice_id" IS NOT NULL
  AND s."legacy_initial_card_payment_succeeded_at" IS NOT NULL
  AND s."stripe_subscription_id" = s."legacy_initial_card_stripe_subscription_id"
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
      AND evidence."stripe_event_created_at" >= s."legacy_initial_card_payment_succeeded_at"
      AND NOT EXISTS (
        SELECT 1
        FROM "audit_events" AS setup_audit
        WHERE setup_audit."organisation_id" = s."organisation_id"
          AND setup_audit."event_type" = 'DIRECT_DEBIT_SETUP_COMPLETED'
          AND setup_audit."correlation_id" = evidence."stripe_event_id"
      )
    HAVING count(*) = 1
      AND min(evidence."stripe_event_created_at") = s."legacy_initial_card_payment_succeeded_at"
  );--> statement-breakpoint
ALTER TABLE "direct_debit_requests" ADD CONSTRAINT "direct_debit_requests_reconciliation_ck" CHECK ((
        "direct_debit_requests"."status" = 'LEGACY_UNBOUND' and (
          (
            "direct_debit_requests"."provider_reconciled_at" is null and
            "direct_debit_requests"."provider_reconciled_by_user_id" is null and
            "direct_debit_requests"."provider_reconciliation_outcome" is null and
            "direct_debit_requests"."provider_reconciliation_reference" is null
          ) or (
            "direct_debit_requests"."provider_reconciled_at" is not null and
            "direct_debit_requests"."provider_reconciled_by_user_id" is not null and
            "direct_debit_requests"."provider_reconciliation_outcome" is not null and
            "direct_debit_requests"."provider_reconciliation_outcome" in ('NO_LEGACY_DEFAULT', 'LEGACY_DEFAULT_REMOVED') and
            "direct_debit_requests"."provider_reconciliation_reference" is not null and
            "direct_debit_requests"."provider_reconciliation_reference" ~ '^cus_[A-Za-z0-9_-]{3,120}[|]sub_[A-Za-z0-9_-]{3,120}[|](pm_[A-Za-z0-9_-]{3,120}|none)$'
          )
        )
      ) or (
        "direct_debit_requests"."status" <> 'LEGACY_UNBOUND' and
        "direct_debit_requests"."provider_reconciled_at" is null and
        "direct_debit_requests"."provider_reconciled_by_user_id" is null and
        "direct_debit_requests"."provider_reconciliation_outcome" is null and
        "direct_debit_requests"."provider_reconciliation_reference" is null
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION direct_debit_require_reconciled_legacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'LEGACY_UNBOUND' AND EXISTS (
    SELECT 1
    FROM direct_debit_requests AS legacy
    WHERE legacy.organisation_id = NEW.organisation_id
      AND legacy.status = 'LEGACY_UNBOUND'
      AND legacy.provider_reconciled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Unresolved legacy direct-debit provider reconciliation blocks current state.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS direct_debit_require_reconciled_legacy_trigger ON direct_debit_requests;--> statement-breakpoint
CREATE TRIGGER direct_debit_require_reconciled_legacy_trigger
BEFORE INSERT OR UPDATE ON direct_debit_requests
FOR EACH ROW EXECUTE FUNCTION direct_debit_require_reconciled_legacy();
