ALTER TYPE "public"."import_batch_status" ADD VALUE IF NOT EXISTS 'deduplicated' BEFORE 'cancelled';
--> statement-breakpoint
ALTER TABLE "import_batches"
  ADD COLUMN "quarantine_object_key" text,
  ADD COLUMN "declared_content_type" text,
  ADD COLUMN "object_etag" text,
  ADD COLUMN "upload_expires_at" timestamptz,
  ADD COLUMN "duplicate_of_batch_id" uuid REFERENCES "import_batches"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "import_batches_upload_expiry_idx"
  ON "import_batches" ("upload_expires_at")
  WHERE "status" = 'pending' AND "upload_completed_at" IS NULL;
--> statement-breakpoint
COMMENT ON COLUMN "import_batches"."declared_content_type" IS
  'Signed upload content type; finalize must match object metadata exactly.';
COMMENT ON COLUMN "import_batches"."object_etag" IS
  'Opaque object-store version marker captured at finalize.';
