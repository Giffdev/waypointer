import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  backgroundJobs,
  backgroundJobState,
  importBatches,
  importBatchStatus,
  importScanStatus,
} from "@/lib/db/schema";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../drizzle/migrations/0002_launch_schema.sql", import.meta.url),
  ),
  "utf8",
);

describe("durable import persistence contract", () => {
  it("models scan, retry, cancellation, quarantine, and expiry explicitly", () => {
    expect(importBatchStatus.enumValues).toEqual(
      expect.arrayContaining([
        "queued",
        "scanning",
        "processing",
        "retrying",
        "cancelled",
        "quarantined",
        "failed",
        "expired",
      ]),
    );
    expect(importScanStatus.enumValues).toEqual([
      "pending",
      "scanning",
      "clean",
      "infected",
      "failed",
      "legacy_unscanned",
    ]);

    const config = getTableConfig(importBatches);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "original_object_key",
        "file_size_bytes",
        "upload_completed_at",
        "scan_status",
        "scan_provider",
        "scan_started_at",
        "scan_completed_at",
        "scan_attempts",
        "retry_count",
        "next_retry_at",
        "cancel_requested_at",
        "cancelled_at",
        "original_deleted_at",
        "snapshots_scrubbed_at",
        "purge_after",
        "purged_at",
      ]),
    );
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "import_batches_scan_attempts_nonnegative",
        "import_batches_retry_count_nonnegative",
        "import_batches_scan_window_valid",
        "import_batches_cancel_window_valid",
        "import_batches_purge_window_valid",
      ]),
    );
  });

  it("supports one idempotent lease holder and a bounded dead-letter path", () => {
    expect(backgroundJobState.enumValues).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "dead_letter",
    ]);

    const config = getTableConfig(backgroundJobs);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "user_id",
        "job_type",
        "payload",
        "idempotency_key",
        "priority",
        "attempts",
        "max_attempts",
        "available_at",
        "lease_owner",
        "lease_expires_at",
        "last_error_code",
        "last_error_message",
        "cancel_requested_at",
        "started_at",
        "completed_at",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "background_jobs_user_type_idempotency_unique",
        "background_jobs_ready_idx",
        "background_jobs_lease_expiry_idx",
      ]),
    );
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "background_jobs_attempts_nonnegative",
        "background_jobs_max_attempts_positive",
        "background_jobs_attempts_bounded",
        "background_jobs_lease_pair",
      ]),
    );
  });

  it("keeps the durable migration additive and owner-attributed", () => {
    expect(migration).toMatch(
      /COMMENT ON TABLE "background_jobs" IS\s+'Internal global queue\. Intentionally has no user RLS/,
    );
    expect(migration).toMatch(
      /ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;\s+ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;/,
    );
    expect(migration).not.toMatch(
      /TRUNCATE|DELETE FROM "import_batches"|DELETE FROM "import_rows"/,
    );
  });
});
