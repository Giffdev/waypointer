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

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_selected_map_share() FROM PUBLIC;
