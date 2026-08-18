CREATE TABLE IF NOT EXISTS "flight_stops" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "flight_id" uuid NOT NULL REFERENCES "flights"("id") ON DELETE cascade,
  "stop_order" integer NOT NULL,
  "airport_id" uuid NOT NULL REFERENCES "airports"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "flight_stops_flight_order_pk" PRIMARY KEY ("flight_id", "stop_order"),
  CONSTRAINT "flight_stops_flight_owner_fk"
    FOREIGN KEY ("flight_id", "user_id")
    REFERENCES "flights"("id", "user_id") ON DELETE cascade,
  CONSTRAINT "flight_stops_order_nonnegative" CHECK ("stop_order" >= 0)
);
CREATE INDEX IF NOT EXISTS "flight_stops_user_flight_idx"
  ON "flight_stops" ("user_id", "flight_id");
ALTER TABLE "map_shares"
  ALTER COLUMN "projection"
  SET DEFAULT '{"owner":{"displayName":null},"summary":{"flightCount":0,"routeCount":0},"routes":[],"flights":[]}'::jsonb;
--> statement-breakpoint
INSERT INTO "flight_stops" ("user_id", "flight_id", "stop_order", "airport_id")
SELECT "user_id", "id", 0, "origin_airport_id"
FROM "flights"
ON CONFLICT ("flight_id", "stop_order") DO NOTHING;
INSERT INTO "flight_stops" ("user_id", "flight_id", "stop_order", "airport_id")
SELECT "user_id", "id", 1, "destination_airport_id"
FROM "flights"
ON CONFLICT ("flight_id", "stop_order") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "flight_stops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flight_stops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "flight_stops_owner_policy" ON "flight_stops";
CREATE POLICY "flight_stops_owner_policy" ON "flight_stops"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true)::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_selected_map_share_for_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_user_id uuid;
  affected_flight_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
    affected_flight_id := OLD.flight_id;
  ELSE
    affected_user_id := NEW.user_id;
    affected_flight_id := NEW.flight_id;
  END IF;
  UPDATE public.map_shares share
  SET disabled_at = now(), updated_at = now()
  WHERE share.user_id = affected_user_id
    AND share.enabled_at IS NOT NULL
    AND share.disabled_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.map_share_flights selected
      WHERE selected.user_id = affected_user_id
        AND selected.flight_id = affected_flight_id
    );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_selected_map_share_for_stop() FROM PUBLIC;
DROP TRIGGER IF EXISTS "flight_stops_invalidate_selected_share" ON "flight_stops";
CREATE TRIGGER "flight_stops_invalidate_selected_share"
BEFORE INSERT OR UPDATE OR DELETE ON "flight_stops"
FOR EACH ROW EXECUTE FUNCTION invalidate_selected_map_share_for_stop();
