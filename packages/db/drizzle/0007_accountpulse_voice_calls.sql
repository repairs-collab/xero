CREATE TABLE "organisation_voice_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" varchar(16) DEFAULT 'RETELL' NOT NULL,
	"secret_arn" text NOT NULL,
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
	"voicemail_template" text NOT NULL,
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
	"approved_script" text,
	"script_hash" text,
	"script_version" integer,
	"agent_id" text NOT NULL,
	"agent_version" integer NOT NULL,
	"voice_id" text NOT NULL,
	"voice_settings_updated_at" timestamp with time zone NOT NULL,
	"transfer_target_label" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" varchar(24) DEFAULT 'DRAFT' NOT NULL,
	"outcome" varchar(32),
	"provider_call_id" text,
	"previewed_at" timestamp with time zone,
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
	CONSTRAINT "voice_call_requests_state_ck" CHECK ("voice_call_requests"."state" in ('DRAFT', 'PREVIEWED', 'APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "voice_call_requests_outcome_ck" CHECK ("voice_call_requests"."outcome" is null or "voice_call_requests"."outcome" in ('IDENTITY_CONFIRMED', 'IDENTITY_NOT_CONFIRMED', 'REMINDER_DELIVERED', 'VOICEMAIL_LEFT', 'WRONG_PERSON', 'TRANSFER_REQUESTED', 'TRANSFERRED', 'TRANSFER_UNANSWERED', 'NO_ANSWER', 'BUSY', 'INVALID_DESTINATION', 'PROVIDER_REJECTED')),
	CONSTRAINT "voice_call_requests_approved_facts_ck" CHECK ("voice_call_requests"."state" not in ('APPROVED', 'QUEUED', 'SUBMITTING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN') or ("voice_call_requests"."approved_script" is not null and "voice_call_requests"."script_hash" is not null and "voice_call_requests"."script_version" is not null and "voice_call_requests"."previewed_at" is not null and "voice_call_requests"."approved_at" is not null))
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
  parent_state varchar(24);
BEGIN
  SELECT state
    INTO parent_state
    FROM voice_call_requests
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.voice_call_id ELSE NEW.voice_call_id END;

  IF parent_state NOT IN ('DRAFT', 'PREVIEWED') THEN
    RAISE EXCEPTION 'approved voice call invoice snapshots are immutable';
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
