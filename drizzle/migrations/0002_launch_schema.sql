DROP INDEX "import_batches_user_hash_active_unique";
ALTER TABLE "import_batches" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "public"."import_batch_status" RENAME TO "import_batch_status_legacy";
CREATE TYPE "public"."import_batch_status" AS ENUM(
  'pending',
  'queued',
  'scanning',
  'processing',
  'retrying',
  'review',
  'committing',
  'committed',
  'cancelled',
  'quarantined',
  'failed',
  'expired'
);
ALTER TABLE "import_batches"
  ALTER COLUMN "status" TYPE "public"."import_batch_status"
  USING "status"::text::"public"."import_batch_status";
ALTER TABLE "import_batches" ALTER COLUMN "status" SET DEFAULT 'pending';
DROP TYPE "public"."import_batch_status_legacy";
CREATE UNIQUE INDEX "import_batches_user_hash_active_unique"
  ON "import_batches" ("user_id", "file_sha256")
  WHERE "status" <> 'expired';
--> statement-breakpoint
CREATE TYPE "public"."import_scan_status" AS ENUM(
  'pending',
  'scanning',
  'clean',
  'infected',
  'failed',
  'legacy_unscanned'
);
--> statement-breakpoint
CREATE TYPE "public"."background_job_state" AS ENUM(
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'dead_letter'
);
--> statement-breakpoint
CREATE TYPE "public"."account_deletion_status" AS ENUM(
  'pending',
  'cancelled',
  'processing',
  'completed',
  'failed'
);
--> statement-breakpoint
ALTER TABLE "import_batches"
  ADD COLUMN "idempotency_key" text,
  ADD COLUMN "upload_completed_at" timestamptz,
  ADD COLUMN "scan_status" "import_scan_status" DEFAULT 'pending' NOT NULL,
  ADD COLUMN "scan_provider" text,
  ADD COLUMN "scan_started_at" timestamptz,
  ADD COLUMN "scan_completed_at" timestamptz,
  ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "next_retry_at" timestamptz,
  ADD COLUMN "last_attempt_at" timestamptz,
  ADD COLUMN "cancel_requested_at" timestamptz,
  ADD COLUMN "cancelled_at" timestamptz,
  ADD COLUMN "cancellation_reason" text,
  ADD COLUMN "original_deleted_at" timestamptz,
  ADD COLUMN "snapshots_scrubbed_at" timestamptz,
  ADD COLUMN "purge_after" timestamptz,
  ADD COLUMN "purged_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "import_batches" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "import_batches"
SET "scan_status" = 'legacy_unscanned',
    "upload_completed_at" = "created_at",
    "idempotency_key" = 'legacy-batch:' || "id"::text
WHERE "scan_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_batches"
  ADD CONSTRAINT "import_batches_scan_attempts_nonnegative"
    CHECK ("scan_attempts" >= 0),
  ADD CONSTRAINT "import_batches_retry_count_nonnegative"
    CHECK ("retry_count" >= 0),
  ADD CONSTRAINT "import_batches_scan_window_valid"
    CHECK ("scan_completed_at" IS NULL OR "scan_started_at" IS NOT NULL),
  ADD CONSTRAINT "import_batches_cancel_window_valid"
    CHECK ("cancelled_at" IS NULL OR "cancel_requested_at" IS NOT NULL),
  ADD CONSTRAINT "import_batches_purge_window_valid"
    CHECK ("purged_at" IS NULL OR "purge_after" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_user_idempotency_unique"
  ON "import_batches" ("user_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "import_batches_retry_ready_idx"
  ON "import_batches" ("next_retry_at", "created_at")
  WHERE "status" = 'retrying';
CREATE INDEX "import_batches_retention_due_idx"
  ON "import_batches" ("expires_at")
  WHERE "status" <> 'expired';
CREATE INDEX "import_batches_purge_due_idx"
  ON "import_batches" ("purge_after")
  WHERE "purged_at" IS NULL AND "purge_after" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "user_profiles" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "display_name" text,
  "time_zone" text DEFAULT 'UTC' NOT NULL,
  "distance_unit" text DEFAULT 'miles' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_profiles_distance_unit_valid"
    CHECK ("distance_unit" IN ('miles', 'kilometers', 'nautical_miles')),
  CONSTRAINT "user_profiles_display_name_length"
    CHECK ("display_name" IS NULL OR char_length("display_name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "job_type" text NOT NULL,
  "state" "background_job_state" DEFAULT 'queued' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text,
  "priority" integer DEFAULT 100 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "last_error_code" text,
  "last_error_message" text,
  "cancel_requested_at" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "background_jobs_attempts_nonnegative" CHECK ("attempts" >= 0),
  CONSTRAINT "background_jobs_max_attempts_positive"
    CHECK ("max_attempts" BETWEEN 1 AND 25),
  CONSTRAINT "background_jobs_attempts_bounded"
    CHECK ("attempts" <= "max_attempts"),
  CONSTRAINT "background_jobs_lease_pair"
    CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_user_type_idempotency_unique"
  ON "background_jobs" ("user_id", "job_type", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX "background_jobs_ready_idx"
  ON "background_jobs" ("priority", "available_at", "created_at")
  WHERE "state" = 'queued';
CREATE INDEX "background_jobs_lease_expiry_idx"
  ON "background_jobs" ("lease_expires_at")
  WHERE "state" = 'running';
CREATE INDEX "background_jobs_user_state_idx"
  ON "background_jobs" ("user_id", "state");
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "status" "account_deletion_status" DEFAULT 'pending' NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "grace_expires_at" timestamptz NOT NULL,
  "cancelled_at" timestamptz,
  "processing_started_at" timestamptz,
  "completed_at" timestamptz,
  "purge_after" timestamptz NOT NULL,
  "last_error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "account_deletion_requests_grace_window"
    CHECK ("grace_expires_at" > "requested_at"),
  CONSTRAINT "account_deletion_requests_purge_window"
    CHECK ("purge_after" >= "grace_expires_at")
);
CREATE UNIQUE INDEX "account_deletion_requests_id_user_unique"
  ON "account_deletion_requests" ("id", "user_id");
CREATE UNIQUE INDEX "account_deletion_requests_one_active_user"
  ON "account_deletion_requests" ("user_id")
  WHERE "status" IN ('pending', 'processing');
CREATE INDEX "account_deletion_requests_grace_due_idx"
  ON "account_deletion_requests" ("grace_expires_at")
  WHERE "status" = 'pending';
CREATE INDEX "account_deletion_requests_purge_due_idx"
  ON "account_deletion_requests" ("purge_after")
  WHERE "status" IN ('pending', 'processing', 'failed');
--> statement-breakpoint
CREATE TABLE "account_deletion_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "account_deletion_tokens_request_owner_fk"
    FOREIGN KEY ("request_id", "user_id")
    REFERENCES "account_deletion_requests"("id", "user_id")
    ON DELETE cascade,
  CONSTRAINT "account_deletion_tokens_hash_length"
    CHECK (char_length("token_hash") = 64)
);
CREATE UNIQUE INDEX "account_deletion_tokens_hash_unique"
  ON "account_deletion_tokens" ("token_hash");
CREATE INDEX "account_deletion_tokens_expiry_idx"
  ON "account_deletion_tokens" ("expires_at")
  WHERE "used_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "deletion_tombstones" (
  "subject_hash" text PRIMARY KEY NOT NULL,
  "deleted_at" timestamptz DEFAULT now() NOT NULL,
  "purge_verified_at" timestamptz,
  "retain_until" timestamptz NOT NULL,
  CONSTRAINT "deletion_tombstones_hash_length"
    CHECK (char_length("subject_hash") = 64),
  CONSTRAINT "deletion_tombstones_retention_window"
    CHECK ("retain_until" > "deleted_at")
);
CREATE INDEX "deletion_tombstones_retention_idx"
  ON "deletion_tombstones" ("retain_until");
--> statement-breakpoint
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_profiles_owner_policy" ON "user_profiles"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "account_deletion_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_deletion_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "account_deletion_requests_owner_policy"
  ON "account_deletion_requests"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
--> statement-breakpoint
COMMENT ON TABLE "background_jobs" IS
  'Internal global queue. Intentionally has no user RLS so workers can claim ready jobs; every job carries an explicit immutable user_id and worker operations must re-check ownership.';
COMMENT ON TABLE "account_deletion_tokens" IS
  'Internal single-use out-of-band control tokens. Stores only SHA-256 token hashes and explicit user ownership; intentionally not exposed through owner queries.';
COMMENT ON TABLE "deletion_tombstones" IS
  'Minimal internal deletion evidence. Contains no user ID, email, username, or flight data.';
