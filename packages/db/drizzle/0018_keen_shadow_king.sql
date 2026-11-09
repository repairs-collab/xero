CREATE TABLE "sms_allowance_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"included_parts" integer DEFAULT 2000 NOT NULL,
	"warning_percent" integer DEFAULT 80 NOT NULL,
	"overage_enabled" boolean DEFAULT false NOT NULL,
	"overage_cap_cents" integer,
	"overage_cents_per_part" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_allowance_included_ck" CHECK ("sms_allowance_settings"."included_parts" >= 1),
	CONSTRAINT "sms_allowance_warning_ck" CHECK ("sms_allowance_settings"."warning_percent" between 1 and 100),
	CONSTRAINT "sms_allowance_cap_ck" CHECK ("sms_allowance_settings"."overage_cap_cents" is null or "sms_allowance_settings"."overage_cap_cents" >= 0),
	CONSTRAINT "sms_allowance_rate_ck" CHECK ("sms_allowance_settings"."overage_cents_per_part" is null or "sms_allowance_settings"."overage_cents_per_part" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sms_number_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"e164_number" varchar(16) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_number_id" varchar(128),
	"status" varchar(24) DEFAULT 'AVAILABLE' NOT NULL,
	"organisation_id" uuid,
	"reserved_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"quarantine_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_number_pool_number_ck" CHECK ("sms_number_pool"."e164_number" ~ '^[+]61[0-9]{9}$'),
	CONSTRAINT "sms_number_pool_status_ck" CHECK ("sms_number_pool"."status" in ('AVAILABLE', 'RESERVED', 'READY', 'QUARANTINED', 'RELEASED')),
	CONSTRAINT "sms_number_pool_assignment_ck" CHECK (("sms_number_pool"."status" in ('AVAILABLE', 'RELEASED') and "sms_number_pool"."organisation_id" is null) or ("sms_number_pool"."status" in ('RESERVED', 'READY', 'QUARANTINED') and "sms_number_pool"."organisation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "sms_usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"billing_period_start" timestamp with time zone NOT NULL,
	"billing_period_end" timestamp with time zone NOT NULL,
	"outbound_message_id" uuid,
	"source" varchar(32) NOT NULL,
	"entry_type" varchar(16) NOT NULL,
	"part_delta" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_usage_ledger_entry_type_ck" CHECK ("sms_usage_ledger"."entry_type" in ('RESERVE', 'COMMIT', 'RELEASE', 'ADJUST')),
	CONSTRAINT "sms_usage_ledger_delta_ck" CHECK (("sms_usage_ledger"."entry_type" in ('RESERVE', 'COMMIT') and "sms_usage_ledger"."part_delta" > 0) or ("sms_usage_ledger"."entry_type" = 'RELEASE' and "sms_usage_ledger"."part_delta" < 0) or ("sms_usage_ledger"."entry_type" = 'ADJUST' and "sms_usage_ledger"."part_delta" <> 0)),
	CONSTRAINT "sms_usage_ledger_period_ck" CHECK ("sms_usage_ledger"."billing_period_end" > "sms_usage_ledger"."billing_period_start")
);
--> statement-breakpoint
ALTER TABLE "sms_allowance_settings" ADD CONSTRAINT "sms_allowance_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_number_pool" ADD CONSTRAINT "sms_number_pool_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_usage_ledger" ADD CONSTRAINT "sms_usage_ledger_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_usage_ledger" ADD CONSTRAINT "sms_usage_ledger_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_number_pool_e164_uq" ON "sms_number_pool" USING btree ("e164_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_number_pool_provider_number_uq" ON "sms_number_pool" USING btree ("provider","provider_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_number_pool_active_org_uq" ON "sms_number_pool" USING btree ("organisation_id") WHERE "sms_number_pool"."organisation_id" is not null and "sms_number_pool"."status" in ('RESERVED', 'READY', 'QUARANTINED');--> statement-breakpoint
CREATE INDEX "sms_number_pool_available_idx" ON "sms_number_pool" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_usage_ledger_org_idempotency_uq" ON "sms_usage_ledger" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sms_usage_ledger_period_idx" ON "sms_usage_ledger" USING btree ("organisation_id","billing_period_start","billing_period_end","occurred_at");--> statement-breakpoint
CREATE INDEX "sms_usage_ledger_outbound_idx" ON "sms_usage_ledger" USING btree ("organisation_id","outbound_message_id","occurred_at");