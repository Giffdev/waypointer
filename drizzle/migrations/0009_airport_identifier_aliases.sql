ALTER TABLE "airports"
  ADD COLUMN "source_ident" text;
--> statement-breakpoint
WITH unique_icao AS (
  SELECT icao
  FROM airports
  WHERE icao IS NOT NULL
  GROUP BY icao
  HAVING count(*) = 1
)
UPDATE airports
SET source_ident = airports.icao
FROM unique_icao
WHERE airports.icao = unique_icao.icao;
--> statement-breakpoint
WITH unique_local AS (
  SELECT local_code
  FROM airports
  WHERE local_code IS NOT NULL
  GROUP BY local_code
  HAVING count(*) = 1
)
UPDATE airports
SET source_ident = airports.local_code
FROM unique_local
WHERE airports.source_ident IS NULL
  AND airports.local_code = unique_local.local_code
  AND NOT EXISTS (
    SELECT 1
    FROM airports assigned
    WHERE assigned.source_ident = airports.local_code
  );
--> statement-breakpoint
WITH unique_iata AS (
  SELECT iata
  FROM airports
  WHERE iata IS NOT NULL
  GROUP BY iata
  HAVING count(*) = 1
)
UPDATE airports
SET source_ident = airports.iata
FROM unique_iata
WHERE airports.source_ident IS NULL
  AND airports.iata = unique_iata.iata
  AND NOT EXISTS (
    SELECT 1
    FROM airports assigned
    WHERE assigned.source_ident = airports.iata
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "airports_source_ident_unique"
  ON "airports" ("source_ident")
  WHERE "source_ident" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "airport_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "airport_id" uuid NOT NULL REFERENCES "airports"("id") ON DELETE cascade,
  "code" text NOT NULL,
  "code_type" text NOT NULL,
  "priority" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "airport_aliases_type_valid"
    CHECK ("code_type" IN ('icao', 'iata', 'faa-lid', 'gps', 'ident', 'local')),
  CONSTRAINT "airport_aliases_priority_positive" CHECK ("priority" > 0)
);
CREATE UNIQUE INDEX "airport_aliases_airport_code_type_unique"
  ON "airport_aliases" ("airport_id", "code", "code_type");
CREATE INDEX "airport_aliases_code_priority_idx"
  ON "airport_aliases" ("code", "priority");
--> statement-breakpoint
INSERT INTO airport_aliases (airport_id, code, code_type, priority)
SELECT id, upper(icao), 'icao', 10
FROM airports
WHERE icao IS NOT NULL
UNION ALL
SELECT id, upper(iata), 'iata', 20
FROM airports
WHERE iata IS NOT NULL
UNION ALL
SELECT id, upper(local_code), 'local', 30
FROM airports
WHERE local_code IS NOT NULL
ON CONFLICT DO NOTHING;
