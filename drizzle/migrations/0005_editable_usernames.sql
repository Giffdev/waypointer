CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique"
  ON "users" (lower("username"));
--> statement-breakpoint
UPDATE "users"
SET "username" = CASE
  WHEN lower(trim("username")) ~ '^[a-z0-9][a-z0-9_-]{2,29}$'
    THEN lower(trim("username"))
  ELSE
    left(
      CASE
        WHEN regexp_replace(
          regexp_replace(lower(trim("username")), '[^a-z0-9_-]+', '_', 'g'),
          '^[^a-z0-9]+',
          ''
        ) ~ '^[a-z0-9].{2,}$'
          THEN regexp_replace(
            regexp_replace(lower(trim("username")), '[^a-z0-9_-]+', '_', 'g'),
            '^[^a-z0-9]+',
            ''
          )
        ELSE 'pilot'
      END,
      21
    ) || '_' || left(replace("id"::text, '-', ''), 8)
END
WHERE "username" <> lower(trim("username"))
   OR lower(trim("username")) !~ '^[a-z0-9][a-z0-9_-]{2,29}$';
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_username_format"
  CHECK ("username" ~ '^[a-z0-9][a-z0-9_-]{2,29}$');
