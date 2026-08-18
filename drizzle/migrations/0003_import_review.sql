ALTER TYPE "public"."duplicate_resolution" ADD VALUE IF NOT EXISTS 'accept_new';
ALTER TYPE "public"."duplicate_resolution" ADD VALUE IF NOT EXISTS 'skip_as_duplicate';
--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_id_user_batch_unique"
  ON "import_rows" ("id", "user_id", "batch_id");
--> statement-breakpoint
ALTER TABLE "duplicate_candidates"
  ALTER COLUMN "flight_a_id" DROP NOT NULL,
  ALTER COLUMN "flight_b_id" DROP NOT NULL,
  ADD COLUMN "batch_id" uuid,
  ADD COLUMN "import_row_id" uuid,
  ADD COLUMN "candidate_import_row_id" uuid,
  ADD COLUMN "candidate_flight_id" uuid,
  ADD COLUMN "candidate_scope" text,
  ADD COLUMN "resolved_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "duplicate_candidates"
  ADD CONSTRAINT "duplicate_candidates_batch_owner_fk"
    FOREIGN KEY ("batch_id", "user_id")
    REFERENCES "import_batches"("id", "user_id")
    ON DELETE cascade,
  ADD CONSTRAINT "duplicate_candidates_row_owner_batch_fk"
    FOREIGN KEY ("import_row_id", "user_id", "batch_id")
    REFERENCES "import_rows"("id", "user_id", "batch_id")
    ON DELETE cascade,
  ADD CONSTRAINT "duplicate_candidates_candidate_row_owner_batch_fk"
    FOREIGN KEY ("candidate_import_row_id", "user_id", "batch_id")
    REFERENCES "import_rows"("id", "user_id", "batch_id")
    ON DELETE cascade,
  ADD CONSTRAINT "duplicate_candidates_candidate_flight_owner_fk"
    FOREIGN KEY ("candidate_flight_id", "user_id")
    REFERENCES "flights"("id", "user_id")
    ON DELETE cascade,
  ADD CONSTRAINT "duplicate_candidates_score_range"
    CHECK ("score" >= 0 AND "score" <= 1),
  ADD CONSTRAINT "duplicate_candidates_import_shape"
    CHECK (
      (
        "import_row_id" IS NULL
        AND "flight_a_id" IS NOT NULL
        AND "flight_b_id" IS NOT NULL
      )
      OR
      (
        "import_row_id" IS NOT NULL
        AND "batch_id" IS NOT NULL
        AND (
          (
            "candidate_scope" = 'existing-flight'
            AND "candidate_flight_id" IS NOT NULL
            AND "candidate_import_row_id" IS NULL
          )
          OR
          (
            "candidate_scope" = 'staged-row'
            AND "candidate_import_row_id" IS NOT NULL
            AND "candidate_flight_id" IS NULL
          )
        )
      )
    );
--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_candidates_user_row_rule_unique"
  ON "duplicate_candidates" ("user_id", "import_row_id", "rule_version")
  WHERE "import_row_id" IS NOT NULL;
CREATE INDEX "duplicate_candidates_user_batch_idx"
  ON "duplicate_candidates" ("user_id", "batch_id");
--> statement-breakpoint
COMMENT ON COLUMN "duplicate_candidates"."candidate_scope" IS
  'Import-review candidate kind. No resolution is automatic; accept_new or skip_as_duplicate must be explicit.';
