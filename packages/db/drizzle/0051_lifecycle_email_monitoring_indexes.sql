CREATE INDEX "lifecycle_email_updated_idx" ON "lifecycle_email_outbox" USING btree ("updated_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "lifecycle_email_status_updated_idx" ON "lifecycle_email_outbox" USING btree ("status", "updated_at" DESC);
