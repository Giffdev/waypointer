ALTER TABLE "sessions"
  ADD COLUMN "authenticated_at" timestamptz DEFAULT now() NOT NULL;
