CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TYPE "public"."import_batch_status" AS ENUM('pending', 'processing', 'review', 'committed', 'failed', 'expired');
--> statement-breakpoint
CREATE TYPE "public"."import_validation_state" AS ENUM('valid', 'warning', 'invalid', 'duplicate');
--> statement-breakpoint
CREATE TYPE "public"."import_user_decision" AS ENUM('pending', 'accepted', 'skipped', 'duplicate');
--> statement-breakpoint
CREATE TYPE "public"."duplicate_resolution" AS ENUM('pending', 'kept_both', 'merged', 'dismissed');
--> statement-breakpoint
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text,
  "email" text NOT NULL,
  "email_verified_at" timestamptz,
  "image" text,
  "username" text NOT NULL,
  "password_hash" text,
  "disabled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" (lower("email"));
CREATE UNIQUE INDEX "users_username_unique" ON "users" (lower("username"));
--> statement-breakpoint
CREATE TABLE "accounts" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "type" text NOT NULL,
  "provider" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "refresh_token" text,
  "access_token" text,
  "expires_at" integer,
  "token_type" text,
  "scope" text,
  "id_token" text,
  "session_state" text,
  CONSTRAINT "accounts_provider_account_pk" PRIMARY KEY("provider","provider_account_id")
);
CREATE INDEX "accounts_user_id_idx" ON "accounts" ("user_id");
--> statement-breakpoint
CREATE TABLE "sessions" (
  "session_token" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "expires" timestamptz NOT NULL
);
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
  "identifier" text NOT NULL,
  "token" text NOT NULL,
  "expires" timestamptz NOT NULL,
  CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
  "credential_id" text UNIQUE NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "provider_account_id" text NOT NULL,
  "credential_public_key" text NOT NULL,
  "counter" integer NOT NULL,
  "credential_device_type" text NOT NULL,
  "credential_backed_up" boolean NOT NULL,
  "transports" text,
  CONSTRAINT "authenticators_user_credential_pk" PRIMARY KEY("user_id","credential_id")
);
--> statement-breakpoint
CREATE TABLE "airports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "icao" text,
  "iata" text,
  "local_code" text,
  "name" text NOT NULL,
  "city" text,
  "country" text NOT NULL,
  "region" text,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "facility" text NOT NULL,
  "scheduled_service" boolean DEFAULT false NOT NULL,
  "dataset_version" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "airports_icao_unique" ON "airports" ("icao") WHERE "icao" IS NOT NULL;
CREATE UNIQUE INDEX "airports_iata_unique" ON "airports" ("iata") WHERE "iata" IS NOT NULL;
CREATE INDEX "airports_local_code_idx" ON "airports" ("local_code");
--> statement-breakpoint
CREATE TABLE "flights" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "fingerprint" text NOT NULL,
  "date" text NOT NULL,
  "origin_airport_id" uuid NOT NULL REFERENCES "airports"("id"),
  "destination_airport_id" uuid NOT NULL REFERENCES "airports"("id"),
  "kind" text NOT NULL,
  "role" text NOT NULL,
  "aircraft" text,
  "aircraft_type" text,
  "registration" text,
  "flight_number" text,
  "airline" text,
  "departure_time" text,
  "distance_miles" double precision,
  "duration_hours" double precision,
  "notes" text,
  "visibility" text DEFAULT 'private' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "flights_user_fingerprint_unique" ON "flights" ("user_id","fingerprint");
CREATE UNIQUE INDEX "flights_id_user_unique" ON "flights" ("id","user_id");
CREATE INDEX "flights_user_date_idx" ON "flights" ("user_id","date");
--> statement-breakpoint
CREATE TABLE "import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "adapter_id" text NOT NULL,
  "adapter_version" integer NOT NULL,
  "status" "import_batch_status" DEFAULT 'pending' NOT NULL,
  "original_object_key" text NOT NULL,
  "original_file_name" text NOT NULL,
  "file_sha256" text NOT NULL,
  "file_size_bytes" bigint NOT NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "parsed_rows" integer DEFAULT 0 NOT NULL,
  "accepted_rows" integer DEFAULT 0 NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "import_batches_user_hash_active_unique" ON "import_batches" ("user_id","file_sha256") WHERE "status" <> 'expired';
CREATE UNIQUE INDEX "import_batches_id_user_unique" ON "import_batches" ("id","user_id");
CREATE INDEX "import_batches_user_created_idx" ON "import_batches" ("user_id","created_at");
--> statement-breakpoint
CREATE TABLE "import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "batch_id" uuid NOT NULL REFERENCES "import_batches"("id") ON DELETE cascade,
  "row_number" integer NOT NULL,
  "raw_snapshot" jsonb NOT NULL,
  "parsed" jsonb NOT NULL,
  "validation_state" "import_validation_state" NOT NULL,
  "match_confidence" double precision,
  "proposed_flight" jsonb,
  "user_decision" "import_user_decision" DEFAULT 'pending' NOT NULL,
  "decided_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
  ,CONSTRAINT "import_rows_batch_owner_fk" FOREIGN KEY ("batch_id","user_id") REFERENCES "import_batches"("id","user_id") ON DELETE cascade
);
CREATE UNIQUE INDEX "import_rows_id_user_unique" ON "import_rows" ("id","user_id");
CREATE UNIQUE INDEX "import_rows_batch_row_unique" ON "import_rows" ("batch_id","row_number");
CREATE INDEX "import_rows_user_batch_idx" ON "import_rows" ("user_id","batch_id");
--> statement-breakpoint
CREATE TABLE "flight_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "flight_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "batch_id" uuid NOT NULL REFERENCES "import_batches"("id") ON DELETE restrict,
  "import_row_id" uuid NOT NULL REFERENCES "import_rows"("id") ON DELETE restrict,
  "source_type" text NOT NULL,
  "external_stable_id" text,
  "source_timestamps" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
  ,CONSTRAINT "flight_sources_flight_owner_fk" FOREIGN KEY ("flight_id","user_id") REFERENCES "flights"("id","user_id") ON DELETE cascade
  ,CONSTRAINT "flight_sources_batch_owner_fk" FOREIGN KEY ("batch_id","user_id") REFERENCES "import_batches"("id","user_id") ON DELETE restrict
  ,CONSTRAINT "flight_sources_row_owner_fk" FOREIGN KEY ("import_row_id","user_id") REFERENCES "import_rows"("id","user_id") ON DELETE restrict
);
CREATE UNIQUE INDEX "flight_sources_user_row_unique" ON "flight_sources" ("user_id","import_row_id");
CREATE INDEX "flight_sources_user_flight_idx" ON "flight_sources" ("user_id","flight_id");
--> statement-breakpoint
CREATE TABLE "flight_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "flight_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "field" text NOT NULL,
  "original_value" jsonb,
  "corrected_value" jsonb NOT NULL,
  "actor" text NOT NULL,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
  ,CONSTRAINT "flight_overrides_flight_owner_fk" FOREIGN KEY ("flight_id","user_id") REFERENCES "flights"("id","user_id") ON DELETE cascade
);
CREATE INDEX "flight_overrides_user_flight_idx" ON "flight_overrides" ("user_id","flight_id");
--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "flight_a_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "flight_b_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "rule_version" integer NOT NULL,
  "score" double precision NOT NULL,
  "explanation" jsonb NOT NULL,
  "resolution" "duplicate_resolution" DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
  ,CONSTRAINT "duplicate_candidates_flight_a_owner_fk" FOREIGN KEY ("flight_a_id","user_id") REFERENCES "flights"("id","user_id") ON DELETE cascade
  ,CONSTRAINT "duplicate_candidates_flight_b_owner_fk" FOREIGN KEY ("flight_b_id","user_id") REFERENCES "flights"("id","user_id") ON DELETE cascade
);
CREATE UNIQUE INDEX "duplicate_candidates_user_pair_rule_unique" ON "duplicate_candidates" ("user_id","flight_a_id","flight_b_id","rule_version");
--> statement-breakpoint
CREATE TABLE "rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX "rate_limits_expires_idx" ON "rate_limits" ("expires_at");
--> statement-breakpoint
ALTER TABLE "flights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flights" FORCE ROW LEVEL SECURITY;
CREATE POLICY "flights_owner_policy" ON "flights"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_batches_owner_policy" ON "import_batches"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_rows_owner_policy" ON "import_rows"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "flight_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flight_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "flight_sources_owner_policy" ON "flight_sources"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "flight_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flight_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "flight_overrides_owner_policy" ON "flight_overrides"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "duplicate_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "duplicate_candidates_owner_policy" ON "duplicate_candidates"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
