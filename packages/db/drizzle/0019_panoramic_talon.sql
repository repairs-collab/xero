CREATE TABLE "platform_admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_organisation_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "platform_status" varchar(16) DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "platform_status_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_role" varchar(16);--> statement-breakpoint
UPDATE "users"
SET "platform_role" = 'OWNER'
WHERE lower("email") = 'repairs@motts.com.au'
  AND "disabled_at" is null;--> statement-breakpoint
ALTER TABLE "platform_admin_audit_events" ADD CONSTRAINT "platform_admin_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admin_audit_events" ADD CONSTRAINT "platform_admin_audit_events_target_organisation_id_organisations_id_fk" FOREIGN KEY ("target_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_admin_audit_target_idx" ON "platform_admin_audit_events" USING btree ("target_organisation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_admin_audit_actor_idx" ON "platform_admin_audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_admin_audit_entity_idx" ON "platform_admin_audit_events" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_admin_audit_correlation_idx" ON "platform_admin_audit_events" USING btree ("correlation_id");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_platform_status_ck" CHECK ("organisations"."platform_status" in ('ACTIVE', 'SUSPENDED'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_platform_status_version_ck" CHECK ("organisations"."platform_status_version" >= 0);--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_platform_suspension_metadata_ck" CHECK (("organisations"."platform_status" = 'ACTIVE' and "organisations"."suspended_at" is null and "organisations"."suspension_reason" is null)
          or ("organisations"."platform_status" = 'SUSPENDED' and "organisations"."suspended_at" is not null and nullif(btrim("organisations"."suspension_reason"), '') is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_platform_admin_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_admin_audit_events is append-only' USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint
CREATE TRIGGER platform_admin_audit_events_append_only
BEFORE UPDATE OR DELETE ON platform_admin_audit_events
FOR EACH ROW
EXECUTE FUNCTION reject_platform_admin_audit_event_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE platform_admin_audit_events FROM PUBLIC;
