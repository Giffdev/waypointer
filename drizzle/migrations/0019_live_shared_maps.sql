-- A shared map is a live view of the owner's current eligible map, not a
-- frozen publication. Two changes make that true.
--
-- 1. A public read resolves the *owner* of an enabled share and then derives
--    the projection from current flights/flight_stops/airports. This function
--    therefore returns an owner id rather than a stored document.
--    `public_map_projection_by_handle(text)` is deliberately left in place: it
--    is what a rolled-back build reads, and it is no longer the source of any
--    current public data.
-- 2. The snapshot-invalidation triggers are dropped. They existed so a frozen
--    publication could never disagree with the owner's map: any flight or
--    route-stop mutation disabled the whole share. A live view cannot disagree
--    with itself, so silently revoking someone's link because they edited a
--    flight is now a defect rather than a safeguard. Revocation is unchanged
--    and still explicit: only `map_shares.disabled_at` (and a deleted or
--    disabled account) removes public access.
CREATE OR REPLACE FUNCTION public_share_owner_by_handle(
  requested_handle text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id
  FROM public.users u
  JOIN public.map_shares ms ON ms.user_id = u.id
  WHERE lower(u.username) = lower(requested_handle)
    AND u.disabled_at IS NULL
    AND ms.enabled_at IS NOT NULL
    AND ms.disabled_at IS NULL
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public_share_owner_by_handle(text) FROM PUBLIC;
COMMENT ON FUNCTION public_share_owner_by_handle(text) IS
  'Read-only owner resolution for an enabled public share by current username. Returns NULL for unknown, reserved, disabled, and revoked handles. Runtime roles require an explicit EXECUTE grant.';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "flights_invalidate_selected_share" ON "flights";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "flight_stops_invalidate_selected_share" ON "flight_stops";
--> statement-breakpoint
COMMENT ON FUNCTION invalidate_selected_map_share() IS
  'Deprecated. Retained unattached so a rollback can re-create its trigger; shared maps are live views and are no longer disabled by owner flight edits.';
--> statement-breakpoint
COMMENT ON FUNCTION invalidate_selected_map_share_for_stop() IS
  'Deprecated. Retained unattached so a rollback can re-create its trigger; shared maps are live views and are no longer disabled by route-stop edits.';
--> statement-breakpoint
COMMENT ON COLUMN "map_shares"."projection" IS
  'Deprecated rollback snapshot. Written when sharing is enabled and never read by the live public projection path, which derives the map from current owner data on every request.';
--> statement-breakpoint
COMMENT ON TABLE "map_share_flights" IS
  'Deprecated rollback membership. Recorded when sharing is enabled; a live shared map covers the owner''s current eligible flights and does not read these rows.';
