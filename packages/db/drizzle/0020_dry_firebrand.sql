ALTER TABLE "invitations" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;