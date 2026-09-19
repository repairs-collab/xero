CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"normalised_number" text NOT NULL,
	"assigned_user_id" uuid,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_message_id" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"provider_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"outbound_message_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_message_id" text,
	"status" varchar(24) NOT NULL,
	"request_dispatched_at" timestamp with time zone,
	"response_received_at" timestamp with time zone,
	"provider_payload" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stage_instance_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"recipient_key" text NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" text,
	"status" varchar(24) DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"queued_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"normalised_destination" text NOT NULL,
	"source" varchar(32) NOT NULL,
	"reason" text NOT NULL,
	"consent_state" varchar(24) NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" text NOT NULL,
	"correlation_id" text,
	"before_value" jsonb,
	"after_value" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"invoice_id" uuid,
	"status" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"scope" varchar(16) NOT NULL,
	"contact_id" uuid,
	"invoice_id" uuid,
	"sequence_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"promised_date" date NOT NULL,
	"grace_days" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"contact_id" uuid,
	"invoice_id" uuid,
	"sequence_id" uuid,
	"assigned_user_id" uuid,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"due_at" timestamp with time zone,
	"summary" text NOT NULL,
	"resolution_note" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_event_key" text NOT NULL,
	"provider_event_id" text,
	"body_hash" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"provider_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"processing_error" text
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organisation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organisation_id_user_id_pk" PRIMARY KEY("organisation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"xero_organisation_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"base_currency" char(3) NOT NULL,
	"send_mode" varchar(16) DEFAULT 'dry-run' NOT NULL,
	"live_send_acknowledged" boolean DEFAULT false NOT NULL,
	"recipient_allowlist" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"xero_sync_cursor" text,
	"last_successful_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_xero_organisation_id_unique" UNIQUE("xero_organisation_id")
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"secret_arn" text NOT NULL,
	"region" varchar(32),
	"callback_key_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone,
	"last_successful_authentication_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_subject" varchar(128) NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_cognito_subject_unique" UNIQUE("cognito_subject"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "contact_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"source_value" text NOT NULL,
	"normalised_value" text NOT NULL,
	"usable" boolean DEFAULT true NOT NULL,
	"approved_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"xero_contact_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"email" text,
	"source_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"xero_invoice_id" varchar(64) NOT NULL,
	"contact_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"type" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount_due" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4),
	"currency" char(3) NOT NULL,
	"online_invoice_url" text,
	"sync_version" integer NOT NULL,
	"xero_updated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stage_instance_id" uuid NOT NULL,
	"rendered_preview" text NOT NULL,
	"source_version" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_chases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" varchar(24) NOT NULL,
	"closed_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_sequence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"daily_basis" varchar(24) DEFAULT 'BUSINESS_DAYS' NOT NULL,
	"sms_aggregation" varchar(32) DEFAULT 'CONSOLIDATED_CUSTOMER' NOT NULL,
	"send_time" time DEFAULT '09:00:00' NOT NULL,
	"social_window_start" time DEFAULT '08:00:00' NOT NULL,
	"social_window_end" time DEFAULT '18:00:00' NOT NULL,
	"minimum_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"max_sms_segments" integer DEFAULT 3 NOT NULL,
	"xero_email_after_sms_opt_out" boolean DEFAULT true NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" varchar(16) DEFAULT 'REVIEW' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"stage_key" varchar(64) NOT NULL,
	"offset_days" integer NOT NULL,
	"channel" varchar(24) NOT NULL,
	"template" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_chase_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"stage_key" varchar(64) NOT NULL,
	"channel" varchar(24) NOT NULL,
	"status" varchar(24) NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"source_version" integer NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_stage_instance_id_stage_instances_id_fk" FOREIGN KEY ("stage_instance_id") REFERENCES "public"."stage_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignments" ADD CONSTRAINT "conversation_assignments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignments" ADD CONSTRAINT "conversation_assignments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignments" ADD CONSTRAINT "conversation_assignments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_sequence_id_reminder_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."reminder_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pauses" ADD CONSTRAINT "pauses_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_promises" ADD CONSTRAINT "payment_promises_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_id_reminder_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."reminder_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_stage_instance_id_stage_instances_id_fk" FOREIGN KEY ("stage_instance_id") REFERENCES "public"."stage_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_chases" ADD CONSTRAINT "invoice_chases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_chases" ADD CONSTRAINT "invoice_chases_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_chases" ADD CONSTRAINT "invoice_chases_sequence_id_reminder_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."reminder_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_chases" ADD CONSTRAINT "invoice_chases_customer_id_contacts_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sequence_versions" ADD CONSTRAINT "reminder_sequence_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sequence_versions" ADD CONSTRAINT "reminder_sequence_versions_sequence_id_reminder_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."reminder_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sequence_versions" ADD CONSTRAINT "reminder_sequence_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sequences" ADD CONSTRAINT "reminder_sequences_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_exclusions" ADD CONSTRAINT "sequence_exclusions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_exclusions" ADD CONSTRAINT "sequence_exclusions_sequence_version_id_reminder_sequence_versions_id_fk" FOREIGN KEY ("sequence_version_id") REFERENCES "public"."reminder_sequence_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_stages" ADD CONSTRAINT "sequence_stages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_stages" ADD CONSTRAINT "sequence_stages_sequence_version_id_reminder_sequence_versions_id_fk" FOREIGN KEY ("sequence_version_id") REFERENCES "public"."reminder_sequence_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD CONSTRAINT "stage_instances_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD CONSTRAINT "stage_instances_invoice_chase_id_invoice_chases_id_fk" FOREIGN KEY ("invoice_chase_id") REFERENCES "public"."invoice_chases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD CONSTRAINT "stage_instances_sequence_version_id_reminder_sequence_versions_id_fk" FOREIGN KEY ("sequence_version_id") REFERENCES "public"."reminder_sequence_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_org_contact_number_uq" ON "conversations" USING btree ("organisation_id","contact_id","normalised_number");--> statement-breakpoint
CREATE INDEX "conversations_recency_idx" ON "conversations" USING btree ("organisation_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_org_provider_message_uq" ON "inbound_messages" USING btree ("organisation_id","provider","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attempts_outbound_number_uq" ON "message_attempts" USING btree ("organisation_id","outbound_message_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attempts_org_provider_message_uq" ON "message_attempts" USING btree ("organisation_id","provider","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_org_idempotency_uq" ON "outbound_messages" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_idx" ON "outbound_messages" USING btree ("organisation_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_org_channel_destination_uq" ON "suppressions" USING btree ("organisation_id","channel","normalised_destination");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("organisation_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("organisation_id","correlation_id");--> statement-breakpoint
CREATE INDEX "conversation_assignments_conversation_idx" ON "conversation_assignments" USING btree ("organisation_id","conversation_id","assigned_at");--> statement-breakpoint
CREATE INDEX "disputes_contact_status_idx" ON "disputes" USING btree ("organisation_id","contact_id","status");--> statement-breakpoint
CREATE INDEX "pauses_active_scope_idx" ON "pauses" USING btree ("organisation_id","active","scope");--> statement-breakpoint
CREATE INDEX "payment_promises_due_idx" ON "payment_promises" USING btree ("organisation_id","status","promised_date");--> statement-breakpoint
CREATE INDEX "tasks_open_idx" ON "tasks" USING btree ("organisation_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_org_provider_event_uq" ON "webhook_events" USING btree ("organisation_id","provider","provider_event_key");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("organisation_id","processed_at","received_at");--> statement-breakpoint
CREATE INDEX "invitations_org_status_idx" ON "invitations" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_org_provider_uq" ON "provider_connections" USING btree ("organisation_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_org_contact_kind_value_uq" ON "contact_channels" USING btree ("organisation_id","contact_id","kind","normalised_value");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_xero_contact_uq" ON "contacts" USING btree ("organisation_id","xero_contact_id");--> statement-breakpoint
CREATE INDEX "contacts_org_active_idx" ON "contacts" USING btree ("organisation_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_xero_invoice_uq" ON "invoices" USING btree ("organisation_id","xero_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_eligibility_idx" ON "invoices" USING btree ("organisation_id","status","amount_due","due_date");--> statement-breakpoint
CREATE INDEX "invoices_contact_idx" ON "invoices" USING btree ("organisation_id","contact_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("organisation_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_chases_org_invoice_sequence_uq" ON "invoice_chases" USING btree ("organisation_id","invoice_id","sequence_id");--> statement-breakpoint
CREATE INDEX "invoice_chases_customer_status_idx" ON "invoice_chases" USING btree ("organisation_id","customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_versions_org_sequence_version_uq" ON "reminder_sequence_versions" USING btree ("organisation_id","sequence_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_sequences_org_name_uq" ON "reminder_sequences" USING btree ("organisation_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_exclusions_version_kind_value_uq" ON "sequence_exclusions" USING btree ("organisation_id","sequence_version_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_stages_version_stage_channel_uq" ON "sequence_stages" USING btree ("organisation_id","sequence_version_id","stage_key","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_instances_occurrence_uq" ON "stage_instances" USING btree ("organisation_id","invoice_chase_id","stage_key","channel","scheduled_at");--> statement-breakpoint
CREATE INDEX "stage_instances_due_idx" ON "stage_instances" USING btree ("organisation_id","status","scheduled_at");