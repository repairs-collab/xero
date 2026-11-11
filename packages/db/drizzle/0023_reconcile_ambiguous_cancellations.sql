-- Record raw Stripe status and a trigger-maintained provenance value.
ALTER TABLE "subscriptions" ADD COLUMN "stripe_provider_status" varchar(32);
ALTER TABLE "subscriptions" ADD COLUMN "trusted_stripe_provider_status" varchar(32);
--> statement-breakpoint
CREATE FUNCTION subscription_clear_status_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.trusted_stripe_provider_status := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION subscription_record_status_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.trusted_stripe_provider_status := NEW.stripe_provider_status;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER a_subscription_clear_status_provenance BEFORE UPDATE OF status ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscription_clear_status_provenance();
--> statement-breakpoint
CREATE TRIGGER b_subscription_record_status_provenance BEFORE UPDATE OF stripe_provider_status ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscription_record_status_provenance();
--> statement-breakpoint
CREATE FUNCTION subscription_normalize_untrusted_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCEL_AT_PERIOD_END' AND NEW.trusted_stripe_provider_status IS DISTINCT FROM 'active' THEN
    NEW.status := 'INCOMPLETE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER z_subscription_normalize_cancellation BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscription_normalize_untrusted_cancellation();
--> statement-breakpoint
-- Old states cannot distinguish active cancellation from payment failure.
UPDATE "subscriptions" SET "status" = 'INCOMPLETE', "updated_at" = now() WHERE "status" = 'CANCEL_AT_PERIOD_END';
