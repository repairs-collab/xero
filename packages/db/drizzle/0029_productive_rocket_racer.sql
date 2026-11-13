CREATE TABLE "reply_number_provisioning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"request_key" varchar(200) NOT NULL,
	"attempt" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(40) DEFAULT 'AWAITING_QUOTE' NOT NULL,
	"quote_setup_fee_minor" integer,
	"quote_monthly_fee_minor" integer,
	"quote_currency" char(3),
	"quote_expires_at" timestamp with time zone,
	"quoted_at" timestamp with time zone,
	"documentation_status" varchar(24) DEFAULT 'UNKNOWN' NOT NULL,
	"documentation_evidence_reference" varchar(256),
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason" varchar(500),
	"external_order_reference" varchar(256),
	"manual_order_recorded_at" timestamp with time zone,
	"fulfilled_number_id" uuid,
	"failure_code" varchar(64),
	"failed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_number_requests_provider_ck" CHECK ("reply_number_provisioning_requests"."provider" ~ '^[A-Z][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "reply_number_requests_status_ck" CHECK ("reply_number_provisioning_requests"."status" in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED', 'FULFILLED', 'FAILED', 'EXPIRED')),
	CONSTRAINT "reply_number_requests_attempt_version_ck" CHECK ("reply_number_provisioning_requests"."attempt" >= 1 and "reply_number_provisioning_requests"."version" >= 1),
	CONSTRAINT "reply_number_requests_quote_amount_ck" CHECK (("reply_number_provisioning_requests"."quote_setup_fee_minor" is null or "reply_number_provisioning_requests"."quote_setup_fee_minor" >= 0)
          and ("reply_number_provisioning_requests"."quote_monthly_fee_minor" is null or "reply_number_provisioning_requests"."quote_monthly_fee_minor" >= 0)
          and ("reply_number_provisioning_requests"."quote_currency" is null or "reply_number_provisioning_requests"."quote_currency" = 'aud')),
	CONSTRAINT "reply_number_requests_quote_bundle_ck" CHECK ((
            "reply_number_provisioning_requests"."quote_setup_fee_minor" is null and
            "reply_number_provisioning_requests"."quote_monthly_fee_minor" is null and
            "reply_number_provisioning_requests"."quote_currency" is null and
            "reply_number_provisioning_requests"."quote_expires_at" is null and
            "reply_number_provisioning_requests"."quoted_at" is null and
            "reply_number_provisioning_requests"."status" in ('AWAITING_QUOTE', 'FAILED')
          ) or (
            "reply_number_provisioning_requests"."quote_setup_fee_minor" is not null and
            "reply_number_provisioning_requests"."quote_monthly_fee_minor" is not null and
            "reply_number_provisioning_requests"."quote_currency" = 'aud' and
            "reply_number_provisioning_requests"."quote_expires_at" is not null and
            "reply_number_provisioning_requests"."quoted_at" is not null and
            "reply_number_provisioning_requests"."quote_expires_at" > "reply_number_provisioning_requests"."quoted_at" and
            "reply_number_provisioning_requests"."status" <> 'AWAITING_QUOTE'
          )),
	CONSTRAINT "reply_number_requests_documentation_ck" CHECK ("reply_number_provisioning_requests"."documentation_status" in ('UNKNOWN', 'NOT_REQUIRED', 'REQUIRED', 'COMPLETE')
          and ("reply_number_provisioning_requests"."status" in ('AWAITING_QUOTE', 'FAILED') or "reply_number_provisioning_requests"."documentation_status" <> 'UNKNOWN')
          and (
            "reply_number_provisioning_requests"."documentation_status" <> 'COMPLETE' or
            nullif(btrim("reply_number_provisioning_requests"."documentation_evidence_reference"), '') is not null
          )
          and (
            "reply_number_provisioning_requests"."status" not in ('MANUAL_ORDER_RECORDED', 'FULFILLED') or
            "reply_number_provisioning_requests"."documentation_status" in ('NOT_REQUIRED', 'COMPLETE')
          )),
	CONSTRAINT "reply_number_requests_approval_ck" CHECK ((
            "reply_number_provisioning_requests"."approved_by_user_id" is null and
            "reply_number_provisioning_requests"."approved_at" is null and
            "reply_number_provisioning_requests"."approval_reason" is null and
            "reply_number_provisioning_requests"."status" not in ('APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED', 'FULFILLED')
          ) or (
            "reply_number_provisioning_requests"."approved_by_user_id" is not null and
            "reply_number_provisioning_requests"."approved_at" is not null and
            nullif(btrim("reply_number_provisioning_requests"."approval_reason"), '') is not null and
            "reply_number_provisioning_requests"."status" not in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'EXPIRED')
          )),
	CONSTRAINT "reply_number_requests_external_order_ck" CHECK ((
            "reply_number_provisioning_requests"."external_order_reference" is null and
            "reply_number_provisioning_requests"."manual_order_recorded_at" is null and
            "reply_number_provisioning_requests"."status" not in ('MANUAL_ORDER_RECORDED', 'FULFILLED')
          ) or (
            nullif(btrim("reply_number_provisioning_requests"."external_order_reference"), '') is not null and
            "reply_number_provisioning_requests"."manual_order_recorded_at" is not null and
            "reply_number_provisioning_requests"."status" not in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'EXPIRED')
          )),
	CONSTRAINT "reply_number_requests_fulfilment_ck" CHECK (("reply_number_provisioning_requests"."status" = 'FULFILLED' and "reply_number_provisioning_requests"."fulfilled_number_id" is not null)
          or ("reply_number_provisioning_requests"."status" <> 'FULFILLED' and "reply_number_provisioning_requests"."fulfilled_number_id" is null)),
	CONSTRAINT "reply_number_requests_failure_ck" CHECK (("reply_number_provisioning_requests"."status" = 'FAILED' and nullif(btrim("reply_number_provisioning_requests"."failure_code"), '') is not null and "reply_number_provisioning_requests"."failed_at" is not null)
          or ("reply_number_provisioning_requests"."status" <> 'FAILED' and "reply_number_provisioning_requests"."failure_code" is null and "reply_number_provisioning_requests"."failed_at" is null)),
	CONSTRAINT "reply_number_requests_expiry_ck" CHECK (("reply_number_provisioning_requests"."status" = 'EXPIRED' and "reply_number_provisioning_requests"."expired_at" is not null)
          or ("reply_number_provisioning_requests"."status" <> 'EXPIRED' and "reply_number_provisioning_requests"."expired_at" is null))
);
--> statement-breakpoint
ALTER TABLE "sms_number_pool" ADD CONSTRAINT "sms_number_pool_org_id_uq" UNIQUE("organisation_id","id");--> statement-breakpoint
ALTER TABLE "reply_number_provisioning_requests" ADD CONSTRAINT "reply_number_provisioning_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_number_provisioning_requests" ADD CONSTRAINT "reply_number_provisioning_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_number_provisioning_requests" ADD CONSTRAINT "reply_number_requests_org_number_fk" FOREIGN KEY ("organisation_id","fulfilled_number_id") REFERENCES "public"."sms_number_pool"("organisation_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_number_requests_request_key_uq" ON "reply_number_provisioning_requests" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_number_requests_org_attempt_uq" ON "reply_number_provisioning_requests" USING btree ("organisation_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_number_requests_active_org_uq" ON "reply_number_provisioning_requests" USING btree ("organisation_id") WHERE "reply_number_provisioning_requests"."status" in ('AWAITING_QUOTE', 'AWAITING_OWNER_APPROVAL', 'APPROVED_FOR_MANUAL_ORDER', 'MANUAL_ORDER_RECORDED');--> statement-breakpoint
CREATE UNIQUE INDEX "reply_number_requests_fulfilled_number_uq" ON "reply_number_provisioning_requests" USING btree ("fulfilled_number_id") WHERE "reply_number_provisioning_requests"."fulfilled_number_id" is not null;--> statement-breakpoint
CREATE INDEX "reply_number_requests_org_created_idx" ON "reply_number_provisioning_requests" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "reply_number_requests_status_updated_idx" ON "reply_number_provisioning_requests" USING btree ("status","updated_at");
