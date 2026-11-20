ALTER TABLE "sms_allowance_settings" ALTER COLUMN "overage_enabled" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "sms_allowance_settings" ALTER COLUMN "overage_cents_per_part" SET DEFAULT 11;
--> statement-breakpoint
UPDATE "sms_allowance_settings" AS settings
SET
	"overage_enabled" = true,
	"overage_cents_per_part" = 11,
	"updated_at" = now()
FROM "organisations" AS organisation
WHERE settings."organisation_id" = organisation."id"
	AND organisation."edition" = 'SOLO';
--> statement-breakpoint
CREATE TABLE "sms_overage_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"stripe_customer_id" varchar(128) NOT NULL,
	"stripe_subscription_id" varchar(128) NOT NULL,
	"billing_period_start" timestamp with time zone NOT NULL,
	"billing_period_end" timestamp with time zone NOT NULL,
	"committed_parts" integer NOT NULL,
	"included_parts" integer NOT NULL,
	"billable_parts" integer NOT NULL,
	"unit_cents" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"stripe_invoice_item_id" varchar(128),
	"stripe_invoice_id" varchar(128),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_overage_statements_period_ck" CHECK ("sms_overage_statements"."billing_period_end" > "sms_overage_statements"."billing_period_start"),
	CONSTRAINT "sms_overage_statements_amounts_ck" CHECK ("sms_overage_statements"."committed_parts" >= 0 and "sms_overage_statements"."included_parts" >= 1 and "sms_overage_statements"."billable_parts" = greatest(0, "sms_overage_statements"."committed_parts" - "sms_overage_statements"."included_parts") and "sms_overage_statements"."unit_cents" = 11 and "sms_overage_statements"."subtotal_cents" = "sms_overage_statements"."billable_parts" * "sms_overage_statements"."unit_cents"),
	CONSTRAINT "sms_overage_statements_status_ck" CHECK ("sms_overage_statements"."status" in ('OPEN', 'PENDING', 'PROCESSING', 'INVOICED', 'FAILED', 'VOID')),
	CONSTRAINT "sms_overage_statements_attempts_ck" CHECK ("sms_overage_statements"."attempt_count" >= 0),
	CONSTRAINT "sms_overage_statements_invoice_ck" CHECK ("sms_overage_statements"."status" <> 'INVOICED' or ("sms_overage_statements"."stripe_invoice_item_id" is not null and "sms_overage_statements"."stripe_invoice_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "sms_overage_statements" ADD CONSTRAINT "sms_overage_statements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sms_overage_statements_org_period_uq" ON "sms_overage_statements" USING btree ("organisation_id","billing_period_start","billing_period_end");
--> statement-breakpoint
CREATE INDEX "sms_overage_statements_due_idx" ON "sms_overage_statements" USING btree ("status","billing_period_end","updated_at");
