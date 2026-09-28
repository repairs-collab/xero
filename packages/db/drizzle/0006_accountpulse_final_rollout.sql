CREATE TABLE "operational_reset_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"status" varchar(24) NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"deployed_commit" varchar(64) NOT NULL,
	"snapshot_identifier" text,
	"row_count_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_purge_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepared_at" timestamp with time zone,
	"snapshot_created_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_reset_runs_status_ck" CHECK ("operational_reset_runs"."status" in ('PREPARING', 'SNAPSHOT_CREATED', 'RESETTING', 'COMPLETED', 'FAILED', 'ABORTED'))
);
--> statement-breakpoint
CREATE TABLE "rollout_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"sync_completed_at" timestamp with time zone NOT NULL,
	"active_contact_count" integer NOT NULL,
	"outstanding_invoice_count" integer NOT NULL,
	"outstanding_totals" jsonb NOT NULL,
	"generated_approval_count" integer NOT NULL,
	"enabled_sequence_count" integer NOT NULL,
	"all_enabled_sequences_review" boolean NOT NULL,
	"acknowledged_by_user_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rollout_reconciliations_nonnegative_counts_ck" CHECK ("rollout_reconciliations"."active_contact_count" >= 0 and "rollout_reconciliations"."outstanding_invoice_count" >= 0 and "rollout_reconciliations"."generated_approval_count" >= 0 and "rollout_reconciliations"."enabled_sequence_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "rollout_scope" varchar(16) DEFAULT 'CONTROLLED' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "maintenance_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "operational_state" varchar(32) DEFAULT 'READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "operational_state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "latest_reconciled_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational_reset_runs" ADD CONSTRAINT "operational_reset_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_reset_runs" ADD CONSTRAINT "operational_reset_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_reconciliations" ADD CONSTRAINT "rollout_reconciliations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_reconciliations" ADD CONSTRAINT "rollout_reconciliations_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_reset_runs_one_active_uq" ON "operational_reset_runs" USING btree ("organisation_id") WHERE "operational_reset_runs"."status" in ('PREPARING', 'SNAPSHOT_CREATED', 'RESETTING', 'FAILED');--> statement-breakpoint
CREATE INDEX "operational_reset_runs_org_requested_idx" ON "operational_reset_runs" USING btree ("organisation_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rollout_reconciliations_org_sync_uq" ON "rollout_reconciliations" USING btree ("organisation_id","sync_completed_at");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_rollout_scope_ck" CHECK ("organisations"."rollout_scope" in ('CONTROLLED', 'CUSTOMER'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_operational_state_ck" CHECK ("organisations"."operational_state" in ('READY', 'RESET_PREPARING', 'RESET_IN_PROGRESS', 'SYNC_REQUIRED', 'RECONCILIATION_REQUIRED', 'RECONCILED', 'RESET_FAILED'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_dry_run_controlled_ck" CHECK ("organisations"."send_mode" <> 'dry-run' or "organisations"."rollout_scope" = 'CONTROLLED');--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_operational_state_version_ck" CHECK ("organisations"."operational_state_version" >= 0);