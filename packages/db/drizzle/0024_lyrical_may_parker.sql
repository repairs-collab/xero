CREATE TABLE "retired_stripe_subscriptions" (
	"stripe_subscription_id" varchar(128) PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retired_stripe_subscriptions" ADD CONSTRAINT "retired_stripe_subscriptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "subscriptions" AS s SET "trial_ends_at" = LEAST(s."created_at" + interval '14 days', now()) FROM "organisations" AS o WHERE s."organisation_id" = o."id" AND o."edition" = 'SOLO' AND s."trial_ends_at" IS NULL;
