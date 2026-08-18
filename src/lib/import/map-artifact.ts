import type { Airport, Flight, MapRoute } from "../flight-data.ts";
import { aggregateRoutesFromFlights } from "../route-aggregation.ts";
import {
  greatCircleStatuteMiles,
  nauticalMilesToStatuteMiles,
  STATS_FACT_SCHEMA_VERSION,
  type DistanceBasis,
  type StatsActivity,
  type StatsFact,
} from "../flight-statistics.ts";
import {
  assessDuplicateCandidates,
  type DuplicateAssessment,
  type NormalizedFlight,
} from "../reconciliation.ts";
import type { AirportResolution } from "./airport-resolution.ts";
import type { ForeFlightFlight, ForeFlightParseResult } from "./foreflight.ts";

export const LOCAL_MAP_ARTIFACT_VERSION = 5 as const;

export type MapSafeProvenance = {
  source: "ForeFlight" | "FlightRadar24";
  adapter: string;
  adapterVersion: number;
  sourceRowNumber: number;
  idempotencyKey: string;
};

export type LocalMapFlight = Flight & {
  distanceBasis: DistanceBasis;
  reconciliation: {
    status: "unique" | "exact-duplicate-candidate" | "ambiguous-duplicate-candidate";
    candidateOfRowNumber?: number;
    rule?: DuplicateAssessment["rule"];
  };
  provenance: MapSafeProvenance;
};

export type LocalMapArtifact = {
  schemaVersion: typeof LOCAL_MAP_ARTIFACT_VERSION;
  statsFactSchemaVersion: typeof STATS_FACT_SCHEMA_VERSION;
  generatedAt: string;
  sourceLabel: string;
  source: {
    adapter: string;
    adapterVersion: number;
    sourceFileSha256: string;
    airportDataset: string;
  };
  summary: {
    importedRows: number;
    mapReadyFlights: number;
    invalidRows: number;
    unresolvedAirportRows: number;
    ambiguousAirportRows: number;
    exactDuplicateCandidates: number;
    ambiguousDuplicateCandidates: number;
  };
  airports: Airport[];
  flights: LocalMapFlight[];
  statsFacts: StatsFact[];
  recentFlights: Flight[];
  routes: MapRoute[];
  stats: {
    records: number;
    flights: number;
    airports: number;
    distanceMiles: number;
    durationHours: number;
    mappedFlights: number;
  };
  review: {
    invalidRows: Array<{ sourceRowNumber: number; issueCodes: string[] }>;
    unresolvedAirportRows: Array<{ sourceRowNumber: number; fields: string[] }>;
    ambiguousAirportRows: Array<{ sourceRowNumber: number; fields: string[] }>;
    duplicateCandidates: Array<{
      sourceRowNumber: number;
      candidateOfRowNumber: number;
      confidence: DuplicateAssessment["confidence"];
      rule: DuplicateAssessment["rule"];
    }>;
  };
};

type Resolver = (identifier: string) => AirportResolution;

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildLocalMapArtifact(
  parsed: ForeFlightParseResult,
  resolveAirport: Resolver,
  metadata: {
    generatedAt: string;
    sourceFileSha256: string;
    airportDataset: string;
  },
): LocalMapArtifact {
  const invalidRows: LocalMapArtifact["review"]["invalidRows"] = [];
  const unresolvedAirportRows: LocalMapArtifact["review"]["unresolvedAirportRows"] = [];
  const ambiguousAirportRows: LocalMapArtifact["review"]["ambiguousAirportRows"] = [];
  const normalizedFlights: NormalizedFlight[] = [];
  const candidates: Array<{
    flight: ForeFlightFlight;
    origin?: Extract<AirportResolution, { status: "resolved" }>;
    destination?: Extract<AirportResolution, { status: "resolved" }>;
  }> = [];

  for (const flight of parsed.flights) {
    const errors = flight.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0 || !flight.date || !flight.originIdentifier || !flight.destinationIdentifier) {
      invalidRows.push({
        sourceRowNumber: flight.sourceRowNumber,
        issueCodes: errors.map((issue) => issue.code),
      });
      candidates.push({ flight });
      continue;
    }

    const originResolution = resolveAirport(flight.originIdentifier);
    const destinationResolution = resolveAirport(flight.destinationIdentifier);
    const unresolvedFields = [
      originResolution.status === "not-found" ? "From" : undefined,
      destinationResolution.status === "not-found" ? "To" : undefined,
    ].filter((field): field is string => Boolean(field));
    const ambiguousFields = [
      originResolution.status === "ambiguous" ? "From" : undefined,
      destinationResolution.status === "ambiguous" ? "To" : undefined,
    ].filter((field): field is string => Boolean(field));

    if (unresolvedFields.length > 0) {
      unresolvedAirportRows.push({ sourceRowNumber: flight.sourceRowNumber, fields: unresolvedFields });
    }
    if (ambiguousFields.length > 0) {
      ambiguousAirportRows.push({ sourceRowNumber: flight.sourceRowNumber, fields: ambiguousFields });
    }

    const origin = originResolution.status === "resolved" ? originResolution : undefined;
    const destination =
      destinationResolution.status === "resolved" ? destinationResolution : undefined;
    candidates.push({ flight, origin, destination });
    normalizedFlights.push({
      userId: "local-preview",
      departureDate: flight.date,
      departureTime: flight.departureTime,
      originCode: origin?.airport.code ?? flight.originIdentifier,
      destinationCode: destination?.airport.code ?? flight.destinationIdentifier,
      kind: flight.kind,
      role: "pilot",
      aircraft: flight.aircraftDisplayName,
      sourceRecordId: `${parsed.adapter.version}:${flight.sourceRowNumber}`,
    });
  }

  const duplicateAssessments = assessDuplicateCandidates(normalizedFlights);
  const assessmentBySourceRow = new Map<number, DuplicateAssessment>();
  const validRows = parsed.flights.filter(
    (flight) =>
      flight.issues.every((issue) => issue.severity !== "error") &&
      flight.date &&
      flight.originIdentifier &&
      flight.destinationIdentifier,
  );
  duplicateAssessments.forEach((assessment) => {
    assessmentBySourceRow.set(validRows[assessment.index].sourceRowNumber, assessment);
  });

  const flights: LocalMapFlight[] = candidates.flatMap(({ flight, origin, destination }) => {
    if (!flight.date || !origin || !destination) return [];
    const assessment = assessmentBySourceRow.get(flight.sourceRowNumber);
    const distanceBasis: DistanceBasis =
      flight.distanceNauticalMiles === undefined
        ? "great-circle"
        : "logged-nautical-converted";
    const distanceMiles =
      flight.distanceNauticalMiles === undefined
        ? greatCircleStatuteMiles(origin.airport, destination.airport)
        : nauticalMilesToStatuteMiles(flight.distanceNauticalMiles);
    const identity = [
      flight.sourceRowNumber,
      flight.date,
      origin.reference.ident,
      destination.reference.ident,
      flight.aircraftDisplayName,
      flight.departureTime ?? "",
    ].join("|");

    return [{
      id: `foreflight-${stableId(identity)}`,
      date: flight.date,
      origin: origin.airport,
      destination: destination.airport,
      kind: "private",
      role: "pilot",
      aircraft: flight.aircraftDisplayName,
      ...(flight.aircraftType ? { aircraftType: flight.aircraftType } : {}),
      ...(flight.aircraftModel ? { aircraftModel: flight.aircraftModel } : {}),
      ...(flight.registration ? { registration: flight.registration } : {}),
      departureTime: flight.departureTime,
      distanceMiles,
      distanceBasis,
      source: "ForeFlight",
      reconciliation: assessment
        ? {
            status:
              assessment.confidence === "exact"
                ? "exact-duplicate-candidate"
                : "ambiguous-duplicate-candidate",
            candidateOfRowNumber: validRows[assessment.candidateOfIndex].sourceRowNumber,
            rule: assessment.rule,
          }
        : { status: "unique" },
      provenance: {
        source: "ForeFlight",
        adapter: parsed.adapter.format,
        adapterVersion: parsed.adapter.version,
        sourceRowNumber: flight.sourceRowNumber,
        idempotencyKey: `foreflight-${stableId(identity)}`,
      },
    }];
  });

  const airportByCode = new Map<string, Airport>();
  for (const flight of flights) {
    airportByCode.set(flight.origin.code, flight.origin);
    airportByCode.set(flight.destination.code, flight.destination);
  }

  const routes = aggregateRoutesFromFlights(flights);
  const airports = [...airportByCode.values()].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const distanceMiles = Math.round(
    flights.reduce((total, flight) => total + flight.distanceMiles, 0),
  );
  const mapFlightByRow = new Map(
    flights.map((flight) => [flight.provenance.sourceRowNumber, flight]),
  );
  const statsFacts = parsed.flights.flatMap((flight): StatsFact[] => {
    if (!flight.date) return [];
    const mapFlight = mapFlightByRow.get(flight.sourceRowNumber);
    const assessment = assessmentBySourceRow.get(flight.sourceRowNumber);
    const activity = foreFlightActivity(flight);
    const loggedDistance =
      flight.distanceNauticalMiles === undefined
        ? undefined
        : nauticalMilesToStatuteMiles(flight.distanceNauticalMiles);
    const estimatedDistance =
      loggedDistance === undefined && mapFlight
        ? greatCircleStatuteMiles(mapFlight.origin, mapFlight.destination)
        : undefined;
    return [{
      id:
        mapFlight?.id ??
        `foreflight-stat-${stableId([
          flight.sourceRowNumber,
          flight.date,
          activity,
        ].join("|"))}`,
      date: flight.date,
      kind: "private",
      role: "pilot",
      activity,
      source: "ForeFlight",
      mapReady: Boolean(mapFlight),
      originCode: mapFlight?.origin.code,
      destinationCode: mapFlight?.destination.code,
      dedupeStatus:
        assessment?.confidence === "exact"
          ? "exact-duplicate"
          : assessment?.confidence === "ambiguous"
            ? "ambiguous"
            : "unique",
      durationHours: flight.totalTimeHours,
      durationStatus: flight.totalTimeStatus,
      hobbsElapsedHours: flight.hobbsElapsedHours,
      hobbsStatus: flight.hobbsStatus,
      distanceMiles: loggedDistance ?? estimatedDistance,
      distanceStatus: flight.distanceStatus,
      distanceBasis:
        loggedDistance !== undefined
          ? "logged-nautical-converted"
          : estimatedDistance !== undefined
            ? "great-circle"
            : undefined,
    }];
  });
  const canonicalStatsFacts = statsFacts.filter(
    (fact) => fact.dedupeStatus !== "exact-duplicate",
  );
  const durationHours = Number(
    canonicalStatsFacts
      .reduce((total, fact) => total + (fact.durationHours ?? 0), 0)
      .toFixed(3),
  );
  const recentFlights = [...flights]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 50);

  return {
    schemaVersion: LOCAL_MAP_ARTIFACT_VERSION,
    statsFactSchemaVersion: STATS_FACT_SCHEMA_VERSION,
    generatedAt: metadata.generatedAt,
    sourceLabel: "Local ForeFlight import",
    source: {
      adapter: parsed.adapter.format,
      adapterVersion: parsed.adapter.version,
      sourceFileSha256: metadata.sourceFileSha256,
      airportDataset: metadata.airportDataset,
    },
    summary: {
      importedRows: parsed.flights.length,
      mapReadyFlights: flights.length,
      invalidRows: invalidRows.length,
      unresolvedAirportRows: unresolvedAirportRows.length,
      ambiguousAirportRows: ambiguousAirportRows.length,
      exactDuplicateCandidates: duplicateAssessments.filter(
        (assessment) => assessment.confidence === "exact",
      ).length,
      ambiguousDuplicateCandidates: duplicateAssessments.filter(
        (assessment) => assessment.confidence === "ambiguous",
      ).length,
    },
    airports,
    flights,
    statsFacts,
    recentFlights,
    routes,
    stats: {
      records: canonicalStatsFacts.length,
      flights: canonicalStatsFacts.filter((fact) => fact.activity === "flight")
        .length,
      airports: airports.length,
      distanceMiles,
      durationHours,
      mappedFlights: flights.length,
    },
    review: {
      invalidRows,
      unresolvedAirportRows,
      ambiguousAirportRows,
      duplicateCandidates: duplicateAssessments.map((assessment) => ({
        sourceRowNumber: validRows[assessment.index].sourceRowNumber,
        candidateOfRowNumber: validRows[assessment.candidateOfIndex].sourceRowNumber,
        confidence: assessment.confidence,
        rule: assessment.rule,
      })),
    },
  };
}

function foreFlightActivity(flight: ForeFlightFlight): StatsActivity {
  if ((flight.simulatedFlightHours ?? 0) > 0) return "simulator";
  if (
    (flight.groundTrainingHours ?? 0) > 0 ||
    (flight.groundTrainingGivenHours ?? 0) > 0
  ) {
    return "ground";
  }
  if (flight.originIdentifier && flight.destinationIdentifier) return "flight";
  return "unknown";
}
