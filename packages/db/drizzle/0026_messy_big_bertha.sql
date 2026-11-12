ALTER TABLE "subscription_events" ADD COLUMN "provider_object_type" varchar(16);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "provider_object_id" varchar(128);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "billing_case_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "billing_case_status" varchar(32);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "blocks_sending" boolean;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "amount_minor" integer;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "held_template" varchar(32);--> statement-breakpoint
ALTER TABLE "transactional_email_outbox" ADD COLUMN "source_event_id" varchar(128);--> statement-breakpoint
CREATE INDEX "subscription_events_operational_order_idx" ON "subscription_events" USING btree ("organisation_id","provider_object_type","provider_object_id","stripe_event_created_at");--> statement-breakpoint
CREATE INDEX "transactional_email_outbox_case_source_idx" ON "transactional_email_outbox" USING btree ("billing_case_id","source_event_id");--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_operational_amount_ck" CHECK ("subscription_events"."amount_minor" is null or "subscription_events"."amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_operational_metadata_ck" CHECK ((
        "subscription_events"."provider_object_type" is null and
        "subscription_events"."provider_object_id" is null and
        "subscription_events"."billing_case_kind" is null and
        "subscription_events"."billing_case_status" is null and
        "subscription_events"."blocks_sending" is null and
        "subscription_events"."amount_minor" is null and
        "subscription_events"."held_template" is null
      ) or (
        "subscription_events"."provider_object_type" is not null and
        "subscription_events"."provider_object_id" is not null and
        "subscription_events"."billing_case_kind" is not null and
        "subscription_events"."billing_case_status" is not null and
        "subscription_events"."blocks_sending" is not null and
        "subscription_events"."amount_minor" is not null and
        "subscription_events"."held_template" is not null
      ));--> statement-breakpoint
CREATE FUNCTION transactional_email_render_data_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.render_data IS DISTINCT FROM NEW.render_data THEN
    RAISE EXCEPTION 'transactional_email_outbox.render_data is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER transactional_email_render_data_immutable
BEFORE UPDATE OF render_data ON transactional_email_outbox
FOR EACH ROW EXECUTE FUNCTION transactional_email_render_data_immutable_guard();
