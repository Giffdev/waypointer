-- Import identity, route waypoints, and version-aware reprocessing.
--
-- Additive and forward-only. Every existing stop keeps the meaning it already
-- had (`landing` recorded from an `endpoint` column), so every statistic,
-- share, and map render is byte-identical the moment this lands. The new
-- capabilities activate only for rows written after it.
--
-- Runner constraints this file is written to:
--   * The migration runner splits this file on the statement-breakpoint marker
--     and executes each chunk inside a transaction, so CREATE INDEX
--     CONCURRENTLY and a post-hoc constraint validation are not available
--     here. Every index below is therefore a plain CREATE INDEX. That is
--     acceptable: these are per-user tables with an owner-scoped working set,
--     and the write lock is held only for the build.
--   * CHECK constraints are added NOT VALID so the ALTER TABLE does not scan
--     the whole table while holding ACCESS EXCLUSIVE. They are correct by
--     construction — the columns are created in this same migration with
--     defaults that satisfy them — and they are enforced for every subsequent
--     write. Validating the pre-existing rows is left to a later
--     out-of-transaction step; nothing depends on it.
--   * Nothing in this file, including comments, may contain the marker text
--     itself: the splitter is textual, so a marker inside a comment cuts the
--     file in the wrong place and the fragment fails to parse.

ALTER TABLE "flights" ADD COLUMN IF NOT EXISTS "fingerprint_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Truthfulness backfill. The pre-v3 fingerprint used version 2 whenever a
-- flight committed more than two stops, and version 1 otherwise. Defaulting
-- every historical row to 1 would state, in a column whose only job is to say
-- which algorithm produced the digest beside it, something false about every
-- multi-stop flight. The stop count is the exact discriminator the old
-- function used, so this restores the real value rather than approximating it.
UPDATE "flights" f
SET "fingerprint_version" = 2
WHERE f."fingerprint_version" <> 2
  AND (
    SELECT count(*) FROM "flight_stops" s WHERE s."flight_id" = f."id"
  ) > 2;
--> statement-breakpoint
ALTER TABLE "flights" ADD COLUMN IF NOT EXISTS "source_row_key" text;
--> statement-breakpoint
ALTER TABLE "flights" ADD COLUMN IF NOT EXISTS "route_raw" text;
--> statement-breakpoint
-- Partial: historical flights have no source row key, and NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS "flights_user_source_row_key_unique"
  ON "flights" ("user_id", "source_row_key")
  WHERE "source_row_key" IS NOT NULL;
--> statement-breakpoint
-- Existing stops are landings recorded from From/To endpoint columns. The
-- defaults state that explicitly rather than backfilling, so the table is not
-- rewritten and the pre-migration reading of every row is preserved exactly.
ALTER TABLE "flight_stops" ADD COLUMN IF NOT EXISTS "stop_kind" text NOT NULL DEFAULT 'landing';
--> statement-breakpoint
ALTER TABLE "flight_stops" ADD COLUMN IF NOT EXISTS "source_field" text NOT NULL DEFAULT 'endpoint';
--> statement-breakpoint
ALTER TABLE "flight_stops" DROP CONSTRAINT IF EXISTS "flight_stops_stop_kind_valid";
--> statement-breakpoint
ALTER TABLE "flight_stops" ADD CONSTRAINT "flight_stops_stop_kind_valid"
  CHECK ("stop_kind" IN ('landing', 'waypoint')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "flight_stops" DROP CONSTRAINT IF EXISTS "flight_stops_source_field_valid";
--> statement-breakpoint
ALTER TABLE "flight_stops" ADD CONSTRAINT "flight_stops_source_field_valid"
  CHECK ("source_field" IN ('endpoint', 'route', 'manual')) NOT VALID;
--> statement-breakpoint
-- Statistics read landings only; this keeps that read cheap once route
-- waypoints start sharing the table.
CREATE INDEX IF NOT EXISTS "flight_stops_landing_idx"
  ON "flight_stops" ("flight_id", "stop_order")
  WHERE "stop_kind" = 'landing';
--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN IF NOT EXISTS "source_row_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_rows_batch_source_row_key_unique"
  ON "import_rows" ("batch_id", "source_row_key")
  WHERE "source_row_key" IS NOT NULL;
--> statement-breakpoint
-- 0 = "staged before the pipeline was versioned". Batches carrying it are the
-- ones eligible for automatic restaging under the current version.
ALTER TABLE "import_batches" ADD COLUMN IF NOT EXISTS "importer_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN IF NOT EXISTS "reprocessed_from_batch_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_batches_reprocessed_from_batch_id_fk'
  ) THEN
    ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_reprocessed_from_batch_id_fk"
      FOREIGN KEY ("reprocessed_from_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- The uniqueness fix. The old index made "same bytes" permanently mean "same
-- outcome": a file staged by a broken importer could never be re-staged by the
-- fixed one, which is precisely how a deployed fix failed to reach the data it
-- fixed. Adding the importer version lets the same bytes stage once per
-- pipeline version while still collapsing same-version re-uploads.
DROP INDEX IF EXISTS "import_batches_user_hash_active_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "import_batches_user_hash_active_unique"
  ON "import_batches" ("user_id", "file_sha256", "importer_version")
  WHERE "status" <> 'expired';
