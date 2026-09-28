CREATE TABLE "reminder_whitelist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"scope" varchar(16) NOT NULL,
	"contact_id" uuid NOT NULL,
	"invoice_id" uuid,
	"reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "reminder_whitelist_target_shape_ck" CHECK (("reminder_whitelist_entries"."scope" = 'CLIENT' and "reminder_whitelist_entries"."invoice_id" is null) or ("reminder_whitelist_entries"."scope" = 'INVOICE' and "reminder_whitelist_entries"."invoice_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "outbound_messages" DROP CONSTRAINT "outbound_messages_stage_instance_id_stage_instances_id_fk";
--> statement-breakpoint
ALTER TABLE "outbound_messages" ALTER COLUMN "stage_instance_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ALTER COLUMN "source_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_replies" ADD COLUMN "outbound_message_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "source" varchar(32) DEFAULT 'AUTOMATED_REMINDER' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD COLUMN "origin" varchar(24) DEFAULT 'AUTOMATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
-- accountpulse-history-backfill:start
UPDATE "stage_instances"
SET "origin" = 'MANUAL_REMINDER'
WHERE "stage_key" = 'manual';--> statement-breakpoint
UPDATE "stage_instances" AS "stage"
SET "created_by_user_id" = (
	SELECT "approval"."decided_by_user_id"
	FROM "approvals" AS "approval"
	WHERE "approval"."stage_instance_id" = "stage"."id"
		AND "approval"."status" = 'APPROVED'
		AND "approval"."decided_by_user_id" IS NOT NULL
	ORDER BY "approval"."decided_at" DESC NULLS LAST, "approval"."created_at" DESC
	LIMIT 1
)
WHERE "stage"."origin" = 'MANUAL_REMINDER'
	AND EXISTS (
		SELECT 1
		FROM "approvals" AS "approval"
		WHERE "approval"."stage_instance_id" = "stage"."id"
			AND "approval"."status" = 'APPROVED'
			AND "approval"."decided_by_user_id" IS NOT NULL
	);--> statement-breakpoint
UPDATE "outbound_messages" AS "outbound"
SET "contact_id" = COALESCE("chase"."customer_id", "invoice"."contact_id"),
	"invoice_id" = "invoice"."id",
	"actor_user_id" = "stage"."created_by_user_id",
	"source" = CASE
		WHEN "outbound"."channel" = 'XERO_EMAIL' THEN 'XERO_EMAIL'
		WHEN "stage"."origin" = 'MANUAL_REMINDER' THEN 'MANUAL_REMINDER'
		ELSE 'AUTOMATED_REMINDER'
	END
FROM "stage_instances" AS "stage"
INNER JOIN "invoice_chases" AS "chase"
	ON "chase"."id" = "stage"."invoice_chase_id"
INNER JOIN "invoices" AS "invoice"
	ON "invoice"."id" = "chase"."invoice_id"
WHERE "outbound"."stage_instance_id" = "stage"."id"
	AND "outbound"."organisation_id" = "stage"."organisation_id"
	AND "chase"."organisation_id" = "outbound"."organisation_id"
	AND "invoice"."organisation_id" = "outbound"."organisation_id";--> statement-breakpoint
UPDATE "outbound_messages" AS "outbound"
SET "content" = (
	SELECT "approval"."rendered_preview"
	FROM "approvals" AS "approval"
	WHERE "approval"."stage_instance_id" = "outbound"."stage_instance_id"
		AND "approval"."status" = 'APPROVED'
	ORDER BY "approval"."decided_at" DESC NULLS LAST, "approval"."created_at" DESC
	LIMIT 1
)
WHERE "outbound"."channel" = 'SMS'
	AND "outbound"."content" IS NULL
	AND EXISTS (
		SELECT 1
		FROM "approvals" AS "approval"
		WHERE "approval"."stage_instance_id" = "outbound"."stage_instance_id"
			AND "approval"."status" = 'APPROVED'
	);--> statement-breakpoint
-- accountpulse-history-backfill:end
ALTER TABLE "reminder_whitelist_entries" ADD CONSTRAINT "reminder_whitelist_entries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_whitelist_entries" ADD CONSTRAINT "reminder_whitelist_entries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_whitelist_entries" ADD CONSTRAINT "reminder_whitelist_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_whitelist_entries" ADD CONSTRAINT "reminder_whitelist_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_whitelist_entries" ADD CONSTRAINT "reminder_whitelist_entries_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_whitelist_active_client_uq" ON "reminder_whitelist_entries" USING btree ("organisation_id","contact_id") WHERE "reminder_whitelist_entries"."scope" = 'CLIENT' and "reminder_whitelist_entries"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_whitelist_active_invoice_uq" ON "reminder_whitelist_entries" USING btree ("organisation_id","invoice_id") WHERE "reminder_whitelist_entries"."scope" = 'INVOICE' and "reminder_whitelist_entries"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "reminder_whitelist_active_lookup_idx" ON "reminder_whitelist_entries" USING btree ("organisation_id","contact_id","invoice_id","removed_at");--> statement-breakpoint
ALTER TABLE "operator_replies" ADD CONSTRAINT "operator_replies_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_stage_instance_id_stage_instances_id_fk" FOREIGN KEY ("stage_instance_id") REFERENCES "public"."stage_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_instances" ADD CONSTRAINT "stage_instances_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_messages_source_idx" ON "outbound_messages" USING btree ("organisation_id","source","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_contact_idx" ON "outbound_messages" USING btree ("organisation_id","contact_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_invoice_idx" ON "outbound_messages" USING btree ("organisation_id","invoice_id","created_at");--> statement-breakpoint
ALTER TABLE "operator_replies" ADD CONSTRAINT "operator_replies_outbound_message_id_unique" UNIQUE("outbound_message_id");
