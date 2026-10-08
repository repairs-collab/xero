CREATE TABLE "voice_gateway_sessions" (
	"gateway_call_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"voice_call_id" uuid NOT NULL,
	"provider_user_number" varchar(32) NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_hash" text NOT NULL,
	"state" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"last_event_sequence" integer DEFAULT 0 NOT NULL,
	"safe_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_gateway_sessions_state_ck" CHECK ("voice_gateway_sessions"."state" in ('PENDING', 'PROVIDER_REQUESTED', 'GATEWAY_LEG_ANSWERED', 'CUSTOMER_RINGING', 'CUSTOMER_ANSWERED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED')),
	CONSTRAINT "voice_gateway_sessions_event_sequence_ck" CHECK ("voice_gateway_sessions"."last_event_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" DROP CONSTRAINT "organisation_voice_settings_provider_ck";--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" DROP CONSTRAINT "organisation_voice_settings_agent_version_ck";--> statement-breakpoint
ALTER TABLE "voice_call_events" DROP CONSTRAINT "voice_call_events_provider_ck";--> statement-breakpoint
ALTER TABLE "voice_call_requests" DROP CONSTRAINT "voice_call_requests_provider_ck";--> statement-breakpoint
ALTER TABLE "voice_call_events" DROP CONSTRAINT "voice_call_events_voice_call_id_voice_call_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "provider" SET DEFAULT 'VOIPCLOUD';--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "secret_reference" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "preview_public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "agent_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "voice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ALTER COLUMN "voice_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call_events" ALTER COLUMN "provider" SET DEFAULT 'VOIPCLOUD';--> statement-breakpoint
ALTER TABLE "voice_call_requests" ALTER COLUMN "provider" SET DEFAULT 'VOIPCLOUD';--> statement-breakpoint
ALTER TABLE "voice_call_requests" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ALTER COLUMN "agent_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ALTER COLUMN "voice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "voipcloud_user_number" varchar(32);--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "tts_voice_id" text;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "gateway_flow_version" integer;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "last_gateway_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "last_gateway_test_succeeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "last_controlled_flow_tested_at" timestamp with time zone;--> statement-breakpoint
-- direct-voipcloud-settings-reset:start
UPDATE "organisation_voice_settings"
   SET "enabled" = false,
       "provider" = 'VOIPCLOUD',
       "secret_reference" = null,
       "preview_public_key" = null,
       "agent_id" = null,
       "agent_version" = null,
       "voice_id" = null,
       "voice_label" = null,
       "last_connection_tested_at" = null,
       "last_connection_test_succeeded" = false,
       "last_gateway_tested_at" = null,
       "last_gateway_test_succeeded" = false,
       "last_controlled_flow_tested_at" = null,
       "configuration_version" = "configuration_version" + 1,
       "updated_at" = now();
-- direct-voipcloud-settings-reset:end
--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "account_name" text;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "voipcloud_user_number" varchar(32);--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "tts_voice_id" text;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "gateway_flow_version" integer;--> statement-breakpoint
ALTER TABLE "voice_gateway_sessions" ADD CONSTRAINT "voice_gateway_sessions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_gateway_sessions" ADD CONSTRAINT "voice_gateway_sessions_org_call_fk" FOREIGN KEY ("organisation_id","voice_call_id") REFERENCES "public"."voice_call_requests"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_gateway_sessions_org_call_uq" ON "voice_gateway_sessions" USING btree ("organisation_id","voice_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_gateway_sessions_org_idempotency_uq" ON "voice_gateway_sessions" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_gateway_sessions_org_user_active_uq" ON "voice_gateway_sessions" USING btree ("organisation_id","provider_user_number") WHERE "voice_gateway_sessions"."state" in ('PENDING', 'PROVIDER_REQUESTED', 'GATEWAY_LEG_ANSWERED', 'CUSTOMER_RINGING', 'CUSTOMER_ANSWERED', 'IN_PROGRESS', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD CONSTRAINT "organisation_voice_settings_gateway_flow_version_ck" CHECK ("organisation_voice_settings"."gateway_flow_version" is null or "organisation_voice_settings"."gateway_flow_version" >= 1);--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD CONSTRAINT "organisation_voice_settings_provider_ck" CHECK ("organisation_voice_settings"."provider" in ('RETELL', 'VOIPCLOUD'));--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD CONSTRAINT "organisation_voice_settings_agent_version_ck" CHECK ("organisation_voice_settings"."agent_version" is null or "organisation_voice_settings"."agent_version" >= 0);--> statement-breakpoint
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_provider_ck" CHECK ("voice_call_events"."provider" in ('RETELL', 'VOIPCLOUD'));--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_voipcloud_snapshot_ck" CHECK ("voice_call_requests"."provider" <> 'VOIPCLOUD' or ("voice_call_requests"."account_name" is not null and "voice_call_requests"."voipcloud_user_number" is not null and "voice_call_requests"."tts_voice_id" is not null and "voice_call_requests"."gateway_flow_version" is not null));--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_gateway_flow_version_ck" CHECK ("voice_call_requests"."gateway_flow_version" is null or "voice_call_requests"."gateway_flow_version" >= 1);--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_provider_ck" CHECK ("voice_call_requests"."provider" in ('RETELL', 'VOIPCLOUD'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approved_voice_call_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'DRAFT' AND (
    NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR
    NEW.contact_id IS DISTINCT FROM OLD.contact_id OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.provider IS DISTINCT FROM OLD.provider OR
    NEW.account_name IS DISTINCT FROM OLD.account_name OR
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
    NEW.voipcloud_user_number IS DISTINCT FROM OLD.voipcloud_user_number OR
    NEW.tts_voice_id IS DISTINCT FROM OLD.tts_voice_id OR
    NEW.gateway_flow_version IS DISTINCT FROM OLD.gateway_flow_version OR
    NEW.voice_settings_updated_at IS DISTINCT FROM OLD.voice_settings_updated_at OR
    NEW.transfer_target_label IS DISTINCT FROM OLD.transfer_target_label OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN
    RAISE EXCEPTION 'approved voice call facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
