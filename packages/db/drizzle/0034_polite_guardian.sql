CREATE TABLE "debt_contact_claims" (
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"channel" varchar(16) NOT NULL,
	"source_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "debt_contact_claims_pk" PRIMARY KEY("organisation_id","contact_id","local_date"),
	CONSTRAINT "debt_contact_claims_channel_ck" CHECK ("debt_contact_claims"."channel" in ('SMS', 'VOICE'))
);
--> statement-breakpoint
ALTER TABLE "debt_contact_claims" ADD CONSTRAINT "debt_contact_claims_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_contact_claims" ADD CONSTRAINT "debt_contact_claims_org_contact_fk" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "public"."contacts"("organisation_id","id") ON DELETE cascade ON UPDATE no action;