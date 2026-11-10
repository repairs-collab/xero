CREATE TABLE "xero_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'CONNECTED' NOT NULL,
	"encrypted_refresh_token" jsonb,
	"granted_scopes" text[] NOT NULL,
	"refresh_token_version" integer DEFAULT 1 NOT NULL,
	"refresh_lease_id" uuid,
	"refresh_lease_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_connections_status_ck" CHECK ("xero_connections"."status" in ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED')),
	CONSTRAINT "xero_connections_token_state_ck" CHECK (("xero_connections"."status" = 'DISCONNECTED' and "xero_connections"."encrypted_refresh_token" is null and "xero_connections"."refresh_lease_id" is null and "xero_connections"."refresh_lease_expires_at" is null) or ("xero_connections"."status" in ('CONNECTED', 'REAUTH_REQUIRED') and "xero_connections"."encrypted_refresh_token" is not null and jsonb_typeof("xero_connections"."encrypted_refresh_token") = 'object' and cardinality("xero_connections"."granted_scopes") > 0)),
	CONSTRAINT "xero_connections_token_version_ck" CHECK ("xero_connections"."refresh_token_version" >= 1),
	CONSTRAINT "xero_connections_refresh_lease_ck" CHECK (("xero_connections"."refresh_lease_id" is null and "xero_connections"."refresh_lease_expires_at" is null) or ("xero_connections"."refresh_lease_id" is not null and "xero_connections"."refresh_lease_expires_at" is not null and "xero_connections"."status" = 'CONNECTED'))
);
--> statement-breakpoint
CREATE TABLE "xero_oauth_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"existing_organisation_id" uuid,
	"flow_purpose" varchar(24) NOT NULL,
	"return_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_oauth_transactions_flow_purpose_ck" CHECK ("xero_oauth_transactions"."flow_purpose" in ('NEW_SOLO', 'CONNECT_EXISTING')),
	CONSTRAINT "xero_oauth_transactions_binding_ck" CHECK (("xero_oauth_transactions"."flow_purpose" = 'NEW_SOLO' and "xero_oauth_transactions"."existing_organisation_id" is null) or ("xero_oauth_transactions"."flow_purpose" = 'CONNECT_EXISTING' and "xero_oauth_transactions"."existing_organisation_id" is not null)),
	CONSTRAINT "xero_oauth_transactions_state_hash_ck" CHECK (length("xero_oauth_transactions"."state_hash") = 64),
	CONSTRAINT "xero_oauth_transactions_return_path_ck" CHECK ("xero_oauth_transactions"."return_path" like '/%' and "xero_oauth_transactions"."return_path" not like '//%')
);
--> statement-breakpoint
CREATE TABLE "xero_pending_authorisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"existing_organisation_id" uuid,
	"flow_purpose" varchar(24) NOT NULL,
	"encrypted_refresh_token" jsonb NOT NULL,
	"candidate_tenants" jsonb NOT NULL,
	"granted_scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_pending_authorisations_flow_purpose_ck" CHECK ("xero_pending_authorisations"."flow_purpose" in ('NEW_SOLO', 'CONNECT_EXISTING')),
	CONSTRAINT "xero_pending_authorisations_binding_ck" CHECK (("xero_pending_authorisations"."flow_purpose" = 'NEW_SOLO' and "xero_pending_authorisations"."existing_organisation_id" is null) or ("xero_pending_authorisations"."flow_purpose" = 'CONNECT_EXISTING' and "xero_pending_authorisations"."existing_organisation_id" is not null)),
	CONSTRAINT "xero_pending_authorisations_token_ck" CHECK (jsonb_typeof("xero_pending_authorisations"."encrypted_refresh_token") = 'object'),
	CONSTRAINT "xero_pending_authorisations_candidates_ck" CHECK (jsonb_typeof("xero_pending_authorisations"."candidate_tenants") = 'array' and jsonb_array_length("xero_pending_authorisations"."candidate_tenants") > 0),
	CONSTRAINT "xero_pending_authorisations_scopes_ck" CHECK (cardinality("xero_pending_authorisations"."granted_scopes") > 0)
);
--> statement-breakpoint
ALTER TABLE "xero_connections" ADD CONSTRAINT "xero_connections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_oauth_transactions" ADD CONSTRAINT "xero_oauth_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_oauth_transactions" ADD CONSTRAINT "xero_oauth_transactions_existing_organisation_id_organisations_id_fk" FOREIGN KEY ("existing_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_pending_authorisations" ADD CONSTRAINT "xero_pending_authorisations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_pending_authorisations" ADD CONSTRAINT "xero_pending_authorisations_existing_organisation_id_organisations_id_fk" FOREIGN KEY ("existing_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "xero_connections_organisation_uq" ON "xero_connections" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "xero_connections_connection_uq" ON "xero_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "xero_connections_tenant_uq" ON "xero_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "xero_connections_status_idx" ON "xero_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "xero_oauth_transactions_state_hash_uq" ON "xero_oauth_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "xero_oauth_transactions_user_expiry_idx" ON "xero_oauth_transactions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "xero_pending_authorisations_user_expiry_idx" ON "xero_pending_authorisations" USING btree ("user_id","expires_at");