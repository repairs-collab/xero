CREATE TABLE "user_legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" varchar(32) NOT NULL,
	"privacy_version" varchar(32) NOT NULL,
	"acceptable_use_version" varchar(32) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_legal_acceptances" ADD CONSTRAINT "user_legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_legal_acceptances_user_versions_uq" ON "user_legal_acceptances" USING btree ("user_id","terms_version","privacy_version","acceptable_use_version");--> statement-breakpoint
CREATE INDEX "user_legal_acceptances_user_accepted_idx" ON "user_legal_acceptances" USING btree ("user_id","accepted_at");