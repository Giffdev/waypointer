-- Rollback for 0019_live_shared_maps.
--
-- Application rollbacks do not revert schema migrations, so a build rolled
-- back past live shared maps would read `map_shares.projection` again — a
-- snapshot written only when sharing was enabled — with nothing left to
-- invalidate it. That build would keep showing a flight its owner has since
-- deleted, which is exactly what the dropped triggers prevented.
--
-- Apply this file with the migration role *before* rolling the application
-- back. It re-attaches the invalidation triggers to the functions 0019 left
-- in place, returns the drizzle ledger to boundary 0018, and conservatively
-- disables every currently enabled share so no stale snapshot is served as
-- though it were current: owners re-enable sharing and the rolled-back build
-- publishes from their current map.
CREATE TRIGGER "flights_invalidate_selected_share"
BEFORE INSERT OR UPDATE OR DELETE ON "flights"
FOR EACH ROW EXECUTE FUNCTION invalidate_selected_map_share();
--> statement-breakpoint
CREATE TRIGGER "flight_stops_invalidate_selected_share"
BEFORE INSERT OR UPDATE OR DELETE ON "flight_stops"
FOR EACH ROW EXECUTE FUNCTION invalidate_selected_map_share_for_stop();
--> statement-breakpoint
-- The schema is not the only thing 0019 moved. `verifyAirportMigrationState`
-- in `scripts/airport-release-migrations.ts` asserts the invalidation
-- triggers are absent at boundary 0019 and present at every earlier
-- boundary, so a database left at ledger 0019 with the triggers back is
-- read as schema drift and the release tooling refuses to run. Removing
-- 0019's row restores boundary 0018, which is the state the rolled-back
-- build expects.
--
-- Deleted by 0019's pinned manifest hash from
-- `config/airport-catalog-release.json`, which addresses exactly that one
-- ledger row: no count arithmetic, and no chance of trimming a migration
-- this rollback does not revert.
DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "hash" = '41afe8284a62ab2b7b1fac77075e593d4295ced2ce4413dc050667bf1b6af5e8';
--> statement-breakpoint
UPDATE "map_shares"
SET
  "disabled_at" = COALESCE("disabled_at", current_timestamp),
  "updated_at" = current_timestamp
WHERE "enabled_at" IS NOT NULL
  AND "disabled_at" IS NULL;
