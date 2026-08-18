CREATE TABLE IF NOT EXISTS "map_shares" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE cascade,
  "public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "token_version" integer DEFAULT 1 NOT NULL,
  "include_display_name" boolean DEFAULT false NOT NULL,
  "scope_type" text DEFAULT 'selected_flights' NOT NULL,
  "projection" jsonb DEFAULT '{"owner":{"displayName":null},"summary":{"flightCount":0,"routeCount":0},"routes":[]}'::jsonb NOT NULL,
  "enabled_at" timestamptz,
  "disabled_at" timestamptz,
  "rotated_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "map_shares_token_hash_length" CHECK (char_length("token_hash") = 64),
  CONSTRAINT "map_shares_token_version_positive" CHECK ("token_version" > 0),
  CONSTRAINT "map_shares_scope_type_valid" CHECK ("scope_type" = 'selected_flights')
);
CREATE UNIQUE INDEX IF NOT EXISTS "map_shares_public_id_unique"
  ON "map_shares" ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "map_shares_token_hash_unique"
  ON "map_shares" ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_share_flights" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "flight_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "selected_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "map_share_flights_user_flight_pk"
    PRIMARY KEY ("user_id", "flight_id"),
  CONSTRAINT "map_share_flights_owner_fk"
    FOREIGN KEY ("flight_id", "user_id")
    REFERENCES "flights"("id", "user_id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "map_share_flights_user_idx"
  ON "map_share_flights" ("user_id");
--> statement-breakpoint
ALTER TABLE "map_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "map_shares" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "map_shares_owner_policy" ON "map_shares";
CREATE POLICY "map_shares_owner_policy" ON "map_shares"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
ALTER TABLE "map_share_flights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "map_share_flights" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "map_share_flights_owner_policy" ON "map_share_flights";
CREATE POLICY "map_share_flights_owner_policy" ON "map_share_flights"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_selected_map_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.map_shares share
  SET disabled_at = now(), updated_at = now()
  WHERE share.user_id = OLD.user_id
    AND share.enabled_at IS NOT NULL
    AND share.disabled_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.map_share_flights selected
      WHERE selected.user_id = OLD.user_id
        AND selected.flight_id = OLD.id
    );
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_selected_map_share() FROM PUBLIC;
DROP TRIGGER IF EXISTS "flights_invalidate_selected_share" ON "flights";
CREATE TRIGGER "flights_invalidate_selected_share"
BEFORE UPDATE OR DELETE ON "flights"
FOR EACH ROW EXECUTE FUNCTION invalidate_selected_map_share();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_map_projection(
  requested_public_id uuid,
  requested_token_hash text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH active_share AS (
    SELECT ms.projection
    FROM public.map_shares ms
    JOIN public.users u ON u.id = ms.user_id
    WHERE ms.public_id = requested_public_id
      AND ms.token_hash = requested_token_hash
      AND ms.enabled_at IS NOT NULL
      AND ms.disabled_at IS NULL
      AND u.disabled_at IS NULL
    LIMIT 1
  )
  SELECT projection FROM active_share;
$$;
REVOKE ALL ON FUNCTION public_map_projection(uuid, text) FROM PUBLIC;
COMMENT ON FUNCTION public_map_projection(uuid, text) IS
  'Read-only capability projection over explicitly selected flights. Runtime roles require an explicit EXECUTE grant.';
