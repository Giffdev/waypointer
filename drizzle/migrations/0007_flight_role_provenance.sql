ALTER TABLE "flights"
  ADD COLUMN "role_origin" text DEFAULT 'legacy-unresolved' NOT NULL,
  ADD COLUMN "source_type" text DEFAULT 'CSV' NOT NULL;
--> statement-breakpoint
WITH source_values AS (
  SELECT
    fs.user_id,
    fs.flight_id,
    min(fs.source_type) AS source_type
  FROM flight_sources fs
  GROUP BY fs.user_id, fs.flight_id
  HAVING count(DISTINCT fs.source_type) = 1
)
UPDATE flights f
SET source_type = source_values.source_type
FROM source_values
WHERE f.user_id = source_values.user_id
  AND f.id = source_values.flight_id
  AND source_values.source_type IN ('ForeFlight', 'FlightRadar24', 'CSV');
--> statement-breakpoint
WITH classified_sources AS (
  SELECT
    fs.user_id,
    fs.flight_id,
    CASE
      WHEN ib.adapter_id = 'foreflight-v1'
        THEN 'private'
      WHEN ib.adapter_id = 'myflightradar24-v1'
        THEN 'commercial'
      WHEN ib.adapter_id = 'generic-csv-v1'
        AND ir.parsed -> 'provenance' ->> 'adapterLabel'
          IN ('MyFlightbook CSV', 'CrewLounge PILOTLOG compatible CSV')
        THEN 'private'
      ELSE NULL
    END AS expected_kind,
    CASE
      WHEN ib.adapter_id = 'foreflight-v1'
        THEN 'pilot'
      WHEN ib.adapter_id = 'myflightradar24-v1'
        THEN 'passenger'
      WHEN ib.adapter_id = 'generic-csv-v1'
        AND ir.parsed -> 'provenance' ->> 'adapterLabel'
          IN ('MyFlightbook CSV', 'CrewLounge PILOTLOG compatible CSV')
        THEN 'pilot'
      ELSE NULL
    END AS expected_role
  FROM flight_sources fs
  JOIN import_batches ib
    ON ib.id = fs.batch_id
    AND ib.user_id = fs.user_id
  JOIN import_rows ir
    ON ir.id = fs.import_row_id
    AND ir.user_id = fs.user_id
),
safe_defaults AS (
  SELECT
    user_id,
    flight_id,
    min(expected_kind) AS expected_kind,
    min(expected_role) AS expected_role
  FROM classified_sources
  GROUP BY user_id, flight_id
  HAVING count(*) FILTER (
      WHERE expected_kind IS NULL OR expected_role IS NULL
    ) = 0
    AND count(DISTINCT expected_kind) = 1
    AND count(DISTINCT expected_role) = 1
),
backfilled AS (
  UPDATE flights f
  SET
    kind = safe_defaults.expected_kind,
    role = safe_defaults.expected_role,
    role_origin = 'source-default',
    updated_at = now()
  FROM safe_defaults
  WHERE f.user_id = safe_defaults.user_id
    AND f.id = safe_defaults.flight_id
    AND NOT EXISTS (
      SELECT 1
      FROM flight_overrides overrides
      WHERE overrides.user_id = f.user_id
        AND overrides.flight_id = f.id
        AND overrides.field IN ('kind', 'role')
    )
    AND (
      f.kind IS DISTINCT FROM safe_defaults.expected_kind
      OR f.role IS DISTINCT FROM safe_defaults.expected_role
      OR f.role_origin = 'legacy-unresolved'
    )
  RETURNING f.id
)
SELECT count(*) FROM backfilled;
--> statement-breakpoint
ALTER TABLE "flights"
  ADD CONSTRAINT "flights_role_origin_valid"
    CHECK ("role_origin" IN ('source-default', 'explicit', 'legacy-unresolved')),
  ADD CONSTRAINT "flights_source_type_valid"
    CHECK ("source_type" IN ('ForeFlight', 'FlightRadar24', 'CSV', 'Manual'));
