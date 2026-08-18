ALTER TABLE "airports"
  ADD COLUMN "search_keywords" text,
  ADD COLUMN "search_key" text;
--> statement-breakpoint
CREATE INDEX "airports_search_key_idx" ON "airports" ("search_key");
