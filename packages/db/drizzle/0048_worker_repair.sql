CREATE TABLE "worker_repair_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"result_code" varchar(32),
	"before_health" varchar(16),
	"after_health" varchar(16),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '5 minutes' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "worker_repair_requests_lifecycle_ck" CHECK (
    ("worker_repair_requests"."status" = 'PENDING' and "worker_repair_requests"."claimed_at" is null and "worker_repair_requests"."completed_at" is null and "worker_repair_requests"."result_code" is null)
    or ("worker_repair_requests"."status" = 'RUNNING' and "worker_repair_requests"."claimed_at" is not null and "worker_repair_requests"."completed_at" is null and "worker_repair_requests"."result_code" is null)
    or ("worker_repair_requests"."status" = 'SUCCEEDED' and "worker_repair_requests"."claimed_at" is not null and "worker_repair_requests"."completed_at" is not null and "worker_repair_requests"."result_code" = 'RESTARTED_HEALTHY' and "worker_repair_requests"."result_code" is not null)
    or ("worker_repair_requests"."status" = 'SKIPPED' and "worker_repair_requests"."completed_at" is not null and "worker_repair_requests"."result_code" in ('ALREADY_HEALTHY', 'STARTUP_IN_PROGRESS', 'CORRECTED_RELEASE_REQUIRED', 'SEND_BACKLOG_REVIEW_REQUIRED', 'OWNER_REVOKED') and "worker_repair_requests"."result_code" is not null)
    or ("worker_repair_requests"."status" = 'FAILED' and "worker_repair_requests"."claimed_at" is not null and "worker_repair_requests"."completed_at" is not null and "worker_repair_requests"."result_code" in ('RESTART_FAILED', 'HEALTH_TIMEOUT', 'SERVICE_UNAVAILABLE') and "worker_repair_requests"."result_code" is not null)
    or ("worker_repair_requests"."status" = 'EXPIRED' and "worker_repair_requests"."completed_at" is not null and "worker_repair_requests"."result_code" in ('EXPIRED_BEFORE_START', 'EXPIRED_AFTER_CLAIM') and "worker_repair_requests"."result_code" is not null)
  ),
	CONSTRAINT "worker_repair_requests_claim_ck" CHECK (
    ("worker_repair_requests"."claimed_at" is null and "worker_repair_requests"."claim_expires_at" is null)
    or ("worker_repair_requests"."claimed_at" is not null and "worker_repair_requests"."claim_expires_at" is not null and "worker_repair_requests"."claim_expires_at" > "worker_repair_requests"."claimed_at")
  ),
	CONSTRAINT "worker_repair_requests_health_ck" CHECK (
    "worker_repair_requests"."before_health" in ('HEALTHY', 'STARTING', 'UNHEALTHY', 'DOWN', 'UNVERIFIED')
    and "worker_repair_requests"."after_health" in ('HEALTHY', 'STARTING', 'UNHEALTHY', 'DOWN', 'UNVERIFIED')
  )
);
--> statement-breakpoint
CREATE TABLE "worker_repair_runner" (
	"id" smallint PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_repair_runner_singleton_ck" CHECK ("worker_repair_runner"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "worker_repair_requests" ADD CONSTRAINT "worker_repair_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "worker_repair_requests_requested_idx" ON "worker_repair_requests" USING btree ("requested_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "worker_repair_requests_one_active_uq" ON "worker_repair_requests" USING btree ((true)) WHERE "worker_repair_requests"."status" in ('PENDING', 'RUNNING');
