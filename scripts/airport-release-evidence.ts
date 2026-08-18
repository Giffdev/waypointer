import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { AirportSeedIdentitySummary } from "./airport-seed-plan.ts";
import { writeContentAddressedJson } from "./airport-release-provenance.ts";

type SqlClient = ReturnType<typeof postgres>;

export interface AirportCatalogAudit {
  totalAirports: number;
  activeDatasetAirports: number;
  staleAirports: number;
  distinctSourceIdentifiers: number;
  verifiedSourceProvenance: number;
  activeDatasetAliases: number;
  totalAliases: number;
  aliasCollisionCodes: number;
  ambiguousTopPriorityAliasCodes: number;
  orphanAliases: number;
  orphanFlightReferences: number;
  identityChecksum: string;
}

export interface AirportReleaseEvidence {
  schemaVersion: 1;
  generatedAt: string;
  status: "passed" | "blocked";
  source: {
    provider: string;
    url: string;
    relativePath: string;
    sha256: string;
    bytes: number;
  };
  target: {
    fingerprint: string;
    databaseName: string;
    confirmationVerified: true;
  };
  catalog: AirportCatalogAudit;
  identity: AirportSeedIdentitySummary;
  reconciliation: {
    scanned: number;
    resolved: number;
    ambiguous: number;
    unknown: number;
    completed: number;
    conflicts: number;
  };
  tests: Array<{
    command: string;
    result: "passed" | "failed";
    exitCode: number;
    outputSha256?: string;
  }>;
}

function numberValue(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Airport catalog audit returned an invalid count.");
  }
  return parsed;
}

export async function auditAirportCatalog(
  sql: SqlClient,
  datasetVersion: string,
  sourceIdentProvenance: string,
): Promise<AirportCatalogAudit> {
  const [counts] = await sql<
    Array<{
      total_airports: string;
      active_airports: string;
      distinct_source_identifiers: string;
      verified_source_provenance: string;
      total_aliases: string;
      active_aliases: string;
      alias_collision_codes: string;
      ambiguous_top_priority_alias_codes: string;
      orphan_aliases: string;
      orphan_flight_references: string;
    }>
  >`
    select
      (select count(*) from airports)::text as total_airports,
      (
        select count(*)
        from airports
        where dataset_version = ${datasetVersion}
      )::text as active_airports,
      (
        select count(distinct source_ident)
        from airports
        where dataset_version = ${datasetVersion}
          and source_ident is not null
      )::text as distinct_source_identifiers,
      (
        select count(*)
        from airports
        where dataset_version = ${datasetVersion}
          and source_ident_provenance = ${sourceIdentProvenance}
      )::text as verified_source_provenance,
      (select count(*) from airport_aliases)::text as total_aliases,
      (
        select count(*)
        from airport_aliases aliases
        join airports on airports.id = aliases.airport_id
        where airports.dataset_version = ${datasetVersion}
      )::text as active_aliases,
      (
        select count(*)
        from (
          select aliases.code
          from airport_aliases aliases
          join airports on airports.id = aliases.airport_id
          where airports.dataset_version = ${datasetVersion}
          group by aliases.code
          having count(distinct aliases.airport_id) > 1
        ) collisions
      )::text as alias_collision_codes,
      (
        select count(*)
        from (
          select ranked.code
          from (
            select
              aliases.code,
              aliases.airport_id,
              aliases.priority,
              min(aliases.priority) over (partition by aliases.code) as best_priority
            from airport_aliases aliases
            join airports on airports.id = aliases.airport_id
            where airports.dataset_version = ${datasetVersion}
          ) ranked
          where ranked.priority = ranked.best_priority
          group by ranked.code
          having count(distinct ranked.airport_id) > 1
        ) ambiguous
      )::text as ambiguous_top_priority_alias_codes,
      (
        select count(*)
        from airport_aliases aliases
        left join airports on airports.id = aliases.airport_id
        where airports.id is null
      )::text as orphan_aliases,
      (
        select count(*)
        from (
          select flights.origin_airport_id as airport_id
          from flights
          left join airports on airports.id = flights.origin_airport_id
          where airports.id is null
          union all
          select flights.destination_airport_id
          from flights
          left join airports on airports.id = flights.destination_airport_id
          where airports.id is null
          union all
          select flight_stops.airport_id
          from flight_stops
          left join airports on airports.id = flight_stops.airport_id
          where airports.id is null
        ) orphaned
      )::text as orphan_flight_references
  `;

  const airportRows = await sql<
    Array<{
      id: string;
      source_ident: string | null;
      source_ident_provenance: string | null;
      icao: string | null;
      iata: string | null;
      local_code: string | null;
      name: string;
      city: string | null;
      country: string;
      latitude: number;
      longitude: number;
      facility: string;
      scheduled_service: boolean;
      dataset_version: string;
    }>
  >`
    select
      id::text,
      source_ident,
      source_ident_provenance,
      icao,
      iata,
      local_code,
      name,
      city,
      country,
      latitude,
      longitude,
      facility,
      scheduled_service,
      dataset_version
    from airports
    where dataset_version = ${datasetVersion}
    order by id
  `;
  const aliasRows = await sql<
    Array<{
      airport_id: string;
      code: string;
      code_type: string;
      priority: number;
    }>
  >`
    select aliases.airport_id::text, aliases.code, aliases.code_type, aliases.priority
    from airport_aliases aliases
    join airports on airports.id = aliases.airport_id
    where airports.dataset_version = ${datasetVersion}
    order by aliases.airport_id, aliases.code, aliases.code_type, aliases.priority
  `;
  const checksum = createHash("sha256");
  for (const row of airportRows) {
    checksum.update(`airport:${JSON.stringify(row)}\n`);
  }
  for (const row of aliasRows) {
    checksum.update(`alias:${JSON.stringify(row)}\n`);
  }

  const totalAirports = numberValue(counts.total_airports);
  const activeDatasetAirports = numberValue(counts.active_airports);
  return {
    totalAirports,
    activeDatasetAirports,
    staleAirports: totalAirports - activeDatasetAirports,
    distinctSourceIdentifiers: numberValue(
      counts.distinct_source_identifiers,
    ),
    verifiedSourceProvenance: numberValue(
      counts.verified_source_provenance,
    ),
    activeDatasetAliases: numberValue(counts.active_aliases),
    totalAliases: numberValue(counts.total_aliases),
    aliasCollisionCodes: numberValue(counts.alias_collision_codes),
    ambiguousTopPriorityAliasCodes: numberValue(
      counts.ambiguous_top_priority_alias_codes,
    ),
    orphanAliases: numberValue(counts.orphan_aliases),
    orphanFlightReferences: numberValue(counts.orphan_flight_references),
    identityChecksum: checksum.digest("hex"),
  };
}

export async function writeAirportReleaseEvidence(
  outputDirectory: string,
  evidence: AirportReleaseEvidence,
): Promise<{ path: string; sha256: string }> {
  return writeContentAddressedJson(
    outputDirectory,
    "airport-release",
    evidence,
  );
}
