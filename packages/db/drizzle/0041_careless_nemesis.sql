ALTER TABLE "organisations" ADD COLUMN "last_successful_sync_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "last_successful_xero_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "rollout_reconciliations" ADD COLUMN "sync_id" uuid;--> statement-breakpoint
UPDATE "rollout_reconciliations" SET "sync_id" = gen_random_uuid() WHERE "sync_id" IS NULL;--> statement-breakpoint
ALTER TABLE "rollout_reconciliations" ALTER COLUMN "sync_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "rollout_reconciliations_org_sync_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "rollout_reconciliations_org_sync_id_uq" ON "rollout_reconciliations" USING btree ("organisation_id","sync_id");
