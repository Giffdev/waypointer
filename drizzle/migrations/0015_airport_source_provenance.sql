ALTER TABLE "airports"
  ADD COLUMN "source_ident_provenance" text;
--> statement-breakpoint
UPDATE "airports"
SET "source_ident_provenance" = 'legacy-code-backfill'
WHERE "source_ident" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "airports"
  ADD CONSTRAINT "airports_source_ident_provenance_valid"
  CHECK (
    (
      "source_ident" IS NULL
      AND "source_ident_provenance" IS NULL
    )
    OR
    (
      "source_ident" IS NOT NULL
      AND (
        "source_ident_provenance" = 'legacy-code-backfill'
        OR "source_ident_provenance" ~ '^ourairports-sha256:[a-f0-9]{64}$'
      )
    )
  );
