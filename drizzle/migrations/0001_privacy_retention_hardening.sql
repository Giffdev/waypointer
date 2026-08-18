UPDATE "accounts"
SET "refresh_token" = NULL,
    "access_token" = NULL,
    "id_token" = NULL
WHERE "refresh_token" IS NOT NULL
   OR "access_token" IS NOT NULL
   OR "id_token" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_refresh_token_null"
  CHECK ("refresh_token" IS NULL);
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_access_token_null"
  CHECK ("access_token" IS NULL);
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_id_token_null"
  CHECK ("id_token" IS NULL);
--> statement-breakpoint
ALTER TABLE "import_rows"
  ALTER COLUMN "raw_snapshot" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_rows" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "import_rows" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "import_rows" AS rows
SET "raw_snapshot" = NULL,
    "updated_at" = now()
FROM "import_batches" AS batches
WHERE rows."batch_id" = batches."id"
  AND rows."user_id" = batches."user_id"
  AND (
    batches."status" IN ('committed', 'expired')
    OR batches."expires_at" <= now()
  );
--> statement-breakpoint
ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;
