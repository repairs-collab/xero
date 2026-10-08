CREATE TABLE "organisation_voice_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" varchar(16) DEFAULT 'RETELL' NOT NULL,
	"secret_reference" text NOT NULL,
	"preview_public_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" integer NOT NULL,
	"voice_id" text NOT NULL,
	"voice_label" text NOT NULL,
	"outbound_number" text NOT NULL,
	"transfer_sip_uri" text,
	"fallback_office_number" text NOT NULL,
	"office_destination_label" text NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"weekday_start_local" time(0) NOT NULL,
	"weekday_end_local" time(0) NOT NULL,
	"last_connection_tested_at" timestamp with time zone,
	"last_connection_test_succeeded" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_voice_settings_provider_ck" CHECK ("organisation_voice_settings"."provider" = 'RETELL'),
	CONSTRAINT "organisation_voice_settings_agent_version_ck" CHECK ("organisation_voice_settings"."agent_version" >= 0),
	CONSTRAINT "organisation_voice_settings_window_ck" CHECK ("organisation_voice_settings"."weekday_start_local" < "organisation_voice_settings"."weekday_end_local")
);
--> statement-breakpoint
CREATE TABLE "voice_call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"voice_call_id" uuid NOT NULL,
	"provider" varchar(16) DEFAULT 'RETELL' NOT NULL,
	"provider_event_key" text NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"safe_state" varchar(24),
	"safe_outcome" varchar(32),
	"safe_metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_call_events_provider_ck" CHECK ("voice_call_events"."provider" = 'RETELL')
);
--> statement-breakpoint
CREATE TABLE "voice_call_invoices" (
	"voice_call_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"xero_invoice_id" varchar(64) NOT NULL,
	"invoice_number" text NOT NULL,
	"amount_due" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"due_date" date NOT NULL,
	"sync_version" integer NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_call_invoices_voice_call_id_invoice_id_pk" PRIMARY KEY("voice_call_id","invoice_id")
);
--> statement-breakpoint
CREATE TABLE "voice_call_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"provider" varchar(16) DEFAULT 'RETELL' NOT NULL,
	"destination_number" text NOT NULL,
	"outbound_number" text NOT NULL,
	"combined_amount" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"call_flow_version" integer,
	"call_flow_hash" text,
	"approved_facts_hash" text,
	"agent_id" text NOT NULL,
	"agent_version" integer NOT NULL,
	"voice_id" text NOT NULL,
	"voice_settings_updated_at" timestamp with time zone NOT NULL,
	"transfer_target_label" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" varchar(24) DEFAULT 'DRAFT' NOT NULL,
	"outcome" varchar(32),
	"provider_call_id" text,
	"approved_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"provider_accepted_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	"failure_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_call_requests_provider_ck" CHECK ("voice_call_requests"."provider" = 'RETELL'),
	CONSTRAINT "voice_call_requests_state_ck" CHECK ("voice_call_requests"."state" in ('DRAFT', 'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "voice_call_requests_outcome_ck" CHECK ("voice_call_requests"."outcome" is null or "voice_call_requests"."outcome" in ('IDENTITY_CONFIRMED', 'IDENTITY_NOT_CONFIRMED', 'REMINDER_DELIVERED', 'VOICEMAIL_LEFT', 'WRONG_PERSON', 'TRANSFER_REQUESTED', 'TRANSFERRED', 'TRANSFER_UNANSWERED', 'NO_ANSWER', 'BUSY', 'INVALID_DESTINATION', 'PROVIDER_REJECTED')),
	CONSTRAINT "voice_call_requests_approved_facts_ck" CHECK ("voice_call_requests"."state" not in ('APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN') or ("voice_call_requests"."call_flow_version" is not null and "voice_call_requests"."call_flow_hash" is not null and "voice_call_requests"."approved_facts_hash" is not null and "voice_call_requests"."approved_at" is not null)),
	CONSTRAINT "voice_call_requests_draft_facts_ck" CHECK ("voice_call_requests"."state" <> 'DRAFT' or ("voice_call_requests"."call_flow_version" is null and "voice_call_requests"."call_flow_hash" is null and "voice_call_requests"."approved_facts_hash" is null and "voice_call_requests"."approved_at" is null and "voice_call_requests"."queued_at" is null))
);
--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD CONSTRAINT "organisation_voice_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD CONSTRAINT "organisation_voice_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_voice_call_id_voice_call_requests_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_call_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_invoices" ADD CONSTRAINT "voice_call_invoices_voice_call_id_voice_call_requests_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_call_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_invoices" ADD CONSTRAINT "voice_call_invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_invoices" ADD CONSTRAINT "voice_call_invoices_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_id_uq" ON "contacts" USING btree ("organisation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_id_uq" ON "invoices" USING btree ("organisation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_requests_org_id_uq" ON "voice_call_requests" USING btree ("organisation_id","id");--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_org_contact_fk" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "public"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_invoices" ADD CONSTRAINT "voice_call_invoices_org_call_fk" FOREIGN KEY ("organisation_id","voice_call_id") REFERENCES "public"."voice_call_requests"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_invoices" ADD CONSTRAINT "voice_call_invoices_org_invoice_fk" FOREIGN KEY ("organisation_id","invoice_id") REFERENCES "public"."invoices"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_org_call_fk" FOREIGN KEY ("organisation_id","voice_call_id") REFERENCES "public"."voice_call_requests"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_events_org_provider_event_uq" ON "voice_call_events" USING btree ("organisation_id","provider","provider_event_key");--> statement-breakpoint
CREATE INDEX "voice_call_events_call_time_idx" ON "voice_call_events" USING btree ("organisation_id","voice_call_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voice_call_invoices_org_invoice_idx" ON "voice_call_invoices" USING btree ("organisation_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_requests_org_idempotency_uq" ON "voice_call_requests" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_requests_org_provider_call_uq" ON "voice_call_requests" USING btree ("organisation_id","provider","provider_call_id") WHERE "voice_call_requests"."provider_call_id" is not null;--> statement-breakpoint
CREATE INDEX "voice_call_requests_org_state_idx" ON "voice_call_requests" USING btree ("organisation_id","state","created_at");--> statement-breakpoint
CREATE INDEX "voice_call_requests_org_contact_idx" ON "voice_call_requests" USING btree ("organisation_id","contact_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_voice_call_invoice_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_state varchar(24);
  new_parent_state varchar(24);
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT state
      INTO old_parent_state
      FROM voice_call_requests
     WHERE id = OLD.voice_call_id;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT state
      INTO new_parent_state
      FROM voice_call_requests
     WHERE id = NEW.voice_call_id;
  END IF;

  IF old_parent_state IS DISTINCT FROM NULL AND old_parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'approved voice call invoice snapshots are immutable';
  END IF;

  IF new_parent_state IS DISTINCT FROM NULL AND new_parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'approved voice call invoice snapshots are immutable';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.voice_call_id IS DISTINCT FROM OLD.voice_call_id OR
    NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR
    NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
  ) THEN
    RAISE EXCEPTION 'voice call invoice snapshot identity is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_call_invoices_immutable_after_approval
BEFORE INSERT OR UPDATE OR DELETE ON voice_call_invoices
FOR EACH ROW EXECUTE FUNCTION protect_approved_voice_call_invoice_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_voice_call_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'DRAFT' AND (
    NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR
    NEW.contact_id IS DISTINCT FROM OLD.contact_id OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.destination_number IS DISTINCT FROM OLD.destination_number OR
    NEW.outbound_number IS DISTINCT FROM OLD.outbound_number OR
    NEW.combined_amount IS DISTINCT FROM OLD.combined_amount OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.call_flow_version IS DISTINCT FROM OLD.call_flow_version OR
    NEW.call_flow_hash IS DISTINCT FROM OLD.call_flow_hash OR
    NEW.approved_facts_hash IS DISTINCT FROM OLD.approved_facts_hash OR
    NEW.agent_id IS DISTINCT FROM OLD.agent_id OR
    NEW.agent_version IS DISTINCT FROM OLD.agent_version OR
    NEW.voice_id IS DISTINCT FROM OLD.voice_id OR
    NEW.voice_settings_updated_at IS DISTINCT FROM OLD.voice_settings_updated_at OR
    NEW.transfer_target_label IS DISTINCT FROM OLD.transfer_target_label OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN
    RAISE EXCEPTION 'approved voice call facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_call_requests_facts_immutable_after_approval
BEFORE UPDATE ON voice_call_requests
FOR EACH ROW EXECUTE FUNCTION protect_approved_voice_call_facts();
