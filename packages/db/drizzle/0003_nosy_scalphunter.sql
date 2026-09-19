CREATE TABLE "operator_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" varchar(24) DEFAULT 'PENDING' NOT NULL,
	"provider_message_id" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_replies" ADD CONSTRAINT "operator_replies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_replies" ADD CONSTRAINT "operator_replies_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_replies" ADD CONSTRAINT "operator_replies_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_replies_org_idempotency_uq" ON "operator_replies" USING btree ("organisation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "operator_replies_conversation_idx" ON "operator_replies" USING btree ("organisation_id","conversation_id","created_at");