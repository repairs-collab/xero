ALTER TABLE "reminder_sequences" ADD COLUMN "kind" varchar(16) DEFAULT 'MESSAGING' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_voice_settings" ADD COLUMN "automatic_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "source" varchar(24) DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "sequence_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "sequence_version_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "stage_key" varchar(64);--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD COLUMN "local_occurrence_date" date;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_sequence_id_reminder_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."reminder_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_sequence_version_id_reminder_sequence_versions_id_fk" FOREIGN KEY ("sequence_version_id") REFERENCES "public"."reminder_sequence_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_call_requests_org_due_sequence_idx" ON "voice_call_requests" USING btree ("organisation_id","state","scheduled_at") WHERE "voice_call_requests"."source" <> 'MANUAL';--> statement-breakpoint
ALTER TABLE "reminder_sequences" ADD CONSTRAINT "reminder_sequences_kind_ck" CHECK ("reminder_sequences"."kind" in ('MESSAGING', 'VOICE'));--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_source_ck" CHECK ("voice_call_requests"."source" in ('MANUAL', 'SEQUENCE_REVIEW', 'SEQUENCE_AUTOMATIC'));--> statement-breakpoint
ALTER TABLE "voice_call_requests" ADD CONSTRAINT "voice_call_requests_sequence_source_ck" CHECK ((
        "voice_call_requests"."source" = 'MANUAL'
        and "voice_call_requests"."sequence_id" is null
        and "voice_call_requests"."sequence_version_id" is null
        and "voice_call_requests"."stage_key" is null
        and "voice_call_requests"."scheduled_at" is null
        and "voice_call_requests"."local_occurrence_date" is null
      ) or (
        "voice_call_requests"."source" in ('SEQUENCE_REVIEW', 'SEQUENCE_AUTOMATIC')
        and "voice_call_requests"."sequence_id" is not null
        and "voice_call_requests"."sequence_version_id" is not null
        and "voice_call_requests"."stage_key" is not null
        and "voice_call_requests"."scheduled_at" is not null
        and "voice_call_requests"."local_occurrence_date" is not null
      ));--> statement-breakpoint
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
    NEW.purpose IS DISTINCT FROM OLD.purpose OR
    NEW.source IS DISTINCT FROM OLD.source OR
    NEW.sequence_id IS DISTINCT FROM OLD.sequence_id OR
    NEW.sequence_version_id IS DISTINCT FROM OLD.sequence_version_id OR
    NEW.stage_key IS DISTINCT FROM OLD.stage_key OR
    NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR
    NEW.local_occurrence_date IS DISTINCT FROM OLD.local_occurrence_date OR
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
