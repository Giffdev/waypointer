CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
DO $waypointer$
DECLARE
  account_record record;
  candidate text;
  attempt integer;
BEGIN
  FOR account_record IN
    SELECT "id"
    FROM "users"
    WHERE lower("username") IN (
      'about', 'account', 'admin', 'admins', 'administrator',
      'administrators', 'api', 'auth', 'favicon', 'flights', 'health',
      'help', 'import', 'login', 'logout', 'manifest', 'map', 'official',
      'privacy', 'profile', 'register', 'robots', 'root', 'security',
      'settings', 'shared', 'sign-in', 'sign-out', 'signup', 'sitemap',
      'staff', 'support', 'system', 'terms', 'u', 'user', 'users',
      'verify', 'waypointer', 'way-pointer', 'webmaster', 'www',
      'abuse', 'moderator', 'moderators', 'postmaster'
    )
    ORDER BY "id"
    FOR UPDATE
  LOOP
    attempt := 0;
    LOOP
      candidate := 'private_' || CASE
        WHEN attempt = 0 THEN
          substr(replace(account_record."id"::text, '-', ''), 1, 22)
        ELSE
          substr(
            encode(
              public.digest(
                account_record."id"::text || ':' || attempt::text,
                'sha256'
              ),
              'hex'
            ),
            1,
            22
          )
      END;
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM "users" existing
        WHERE existing."id" <> account_record."id"
          AND lower(existing."username") = candidate
      );
      attempt := attempt + 1;
    END LOOP;

    UPDATE "users"
    SET
      "username" = candidate,
      "updated_at" = current_timestamp
    WHERE "id" = account_record."id";
  END LOOP;
END
$waypointer$;
--> statement-breakpoint
UPDATE "map_shares"
SET
  "disabled_at" = COALESCE("disabled_at", current_timestamp),
  "updated_at" = current_timestamp
WHERE "enabled_at" IS NOT NULL
  AND "disabled_at" IS NULL;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public_map_projection(uuid, text);
DROP FUNCTION IF EXISTS public_map_projection_by_handle(text, text);
DROP INDEX IF EXISTS "map_shares_public_id_unique";
DROP INDEX IF EXISTS "map_shares_token_hash_unique";
ALTER TABLE "map_shares"
  DROP CONSTRAINT IF EXISTS "map_shares_token_hash_length",
  DROP CONSTRAINT IF EXISTS "map_shares_token_version_positive",
  DROP CONSTRAINT IF EXISTS "map_shares_scope_type_valid",
  DROP COLUMN IF EXISTS "public_id",
  DROP COLUMN IF EXISTS "token_hash",
  DROP COLUMN IF EXISTS "token_version",
  DROP COLUMN IF EXISTS "include_display_name",
  DROP COLUMN IF EXISTS "scope_type",
  DROP COLUMN IF EXISTS "rotated_at";
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_public_handle_not_reserved"
  CHECK (
    lower("username") NOT IN (
      'about', 'account', 'admin', 'admins', 'administrator',
      'administrators', 'api', 'auth', 'favicon', 'flights', 'health',
      'help', 'import', 'login', 'logout', 'manifest', 'map', 'official',
      'privacy', 'profile', 'register', 'robots', 'root', 'security',
      'settings', 'shared', 'sign-in', 'sign-out', 'signup', 'sitemap',
      'staff', 'support', 'system', 'terms', 'u', 'user', 'users',
      'verify', 'waypointer', 'way-pointer', 'webmaster', 'www',
      'abuse', 'moderator', 'moderators', 'postmaster'
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "users"
  VALIDATE CONSTRAINT "users_public_handle_not_reserved";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public_map_projection_by_handle(
  requested_handle text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH active_share AS (
    SELECT ms.projection
    FROM public.users u
    JOIN public.map_shares ms ON ms.user_id = u.id
    WHERE lower(u.username) = lower(requested_handle)
      AND u.disabled_at IS NULL
      AND ms.enabled_at IS NOT NULL
      AND ms.disabled_at IS NULL
    LIMIT 1
  )
  SELECT projection FROM active_share;
$$;
REVOKE ALL ON FUNCTION public_map_projection_by_handle(text) FROM PUBLIC;
COMMENT ON FUNCTION public_map_projection_by_handle(text) IS
  'Read-only public map resolution by current username. Runtime roles require an explicit EXECUTE grant.';
