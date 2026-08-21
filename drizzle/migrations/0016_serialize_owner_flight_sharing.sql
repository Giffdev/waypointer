CREATE OR REPLACE FUNCTION invalidate_selected_map_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  affected_user_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.user_id ELSE OLD.user_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(affected_user_id::text, 0));

  IF TG_OP <> 'INSERT' THEN
    UPDATE public.map_shares share
    SET disabled_at = now(), updated_at = now()
    WHERE share.user_id = affected_user_id
      AND share.enabled_at IS NOT NULL
      AND share.disabled_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.map_share_flights selected
        WHERE selected.user_id = affected_user_id
          AND selected.flight_id = OLD.id
      );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_selected_map_share() FROM PUBLIC;
DROP TRIGGER IF EXISTS "flights_invalidate_selected_share" ON "flights";
CREATE TRIGGER "flights_invalidate_selected_share"
BEFORE INSERT OR UPDATE OR DELETE ON "flights"
FOR EACH ROW EXECUTE FUNCTION invalidate_selected_map_share();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_selected_map_share_for_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.user_id::text, 0));
  ELSE
    FOR affected_user_id IN
      SELECT owner_id
      FROM (
        VALUES (OLD.user_id), (NEW.user_id)
      ) AS owners(owner_id)
      GROUP BY owner_id
      ORDER BY owner_id
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended(affected_user_id::text, 0)
      );
    END LOOP;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    UPDATE public.map_shares share
    SET disabled_at = now(), updated_at = now()
    WHERE share.user_id = OLD.user_id
      AND share.enabled_at IS NOT NULL
      AND share.disabled_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.map_share_flights selected
        WHERE selected.user_id = OLD.user_id
          AND selected.flight_id = OLD.flight_id
      );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    UPDATE public.map_shares share
    SET disabled_at = now(), updated_at = now()
    WHERE share.user_id = NEW.user_id
      AND share.enabled_at IS NOT NULL
      AND share.disabled_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.map_share_flights selected
        WHERE selected.user_id = NEW.user_id
          AND selected.flight_id = NEW.flight_id
      );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_selected_map_share_for_stop() FROM PUBLIC;
