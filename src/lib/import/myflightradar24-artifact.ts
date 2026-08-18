import type { Airport, Flight, MapRoute } from "../flight-data.ts";
import { aggregateRoutesFromFlights } from "../route-aggregation.ts";
import {
  greatCircleStatuteMiles,
  STATS_FACT_SCHEMA_VERSION,
  type StatsFact,
} from "../flight-statistics.ts";
import {
  assessDuplicateCandidates,
  findRoleDistinctOverlaps,
  type DuplicateAssessment,
  type NormalizedFlight,
} from "../reconciliation.ts";
import type { AirportResolution } from "./airport-resolution.ts";
import type {
  MyFlightRadar24Flight,
  MyFlightRadar24ParseResult,
} from "./myflightradar24.ts";
import type { MapSafeProvenance } from "./map-artifact.ts";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "../flight-metadata.ts";

export const MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION = 4 as const;

export type MyFlightRadar24MapFlight = Flight & {
  role: "passenger";
  source: "FlightRadar24";
  reconciliation: {
    status: "unique" | "exact-duplicate-candidate" | "ambiguous-duplicate-candidate";
    candidateOfRowNumber?: number;
    rule?: DuplicateAssessment["rule"];
  };
  provenance: MapSafeProvenance;
};

export type MyFlightRadar24MapArtifact = {
  schemaVersion: typeof MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION;
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
    roleDistinctOverlapCandidates: number;
  };
  airports: Airport[];
  flights: MyFlightRadar24MapFlight[];
  statsFacts: StatsFact[];
  routes: MapRoute[];
  review: {
    invalidRows: Array<{ sourceRowNumber: number; issueCodes: string[] }>;
    unresolvedAirportRows: Array<{
      sourceRowNumber: number;
      fields: string[];
      identifiers: string[];
    }>;
    ambiguousAirportRows: Array<{
      sourceRowNumber: number;
      fields: string[];
      identifiers: string[];
    }>;
    duplicateCandidates: Array<{
      sourceRowNumber: number;
      candidateOfRowNumber: number;
      confidence: DuplicateAssessment["confidence"];
      rule: DuplicateAssessment["rule"];
    }>;
  };
};

type Resolver = (identifier: string) => AirportResolution;

function resolveAirportPair(
  resolveAirport: Resolver,
  icaoIdentifier: string | undefined,
  iataIdentifier: string,
): AirportResolution {
  if (icaoIdentifier) {
    const icaoResolution = resolveAirport(icaoIdentifier);
    if (icaoResolution.status !== "not-found") return icaoResolution;
  }
  return resolveAirport(iataIdentifier);
}

export function buildMyFlightRadar24MapArtifact(
  parsed: MyFlightRadar24ParseResult,
  resolveAirport: Resolver,
  metadata: {
    generatedAt: string;
    sourceFileSha256: string;
    airportDataset: string;
    comparisonFlights?: Flight[];
  },
): MyFlightRadar24MapArtifact {
  const invalidRows: MyFlightRadar24MapArtifact["review"]["invalidRows"] = [];
  const unresolvedAirportRows: MyFlightRadar24MapArtifact["review"]["unresolvedAirportRows"] = [];
  const ambiguousAirportRows: MyFlightRadar24MapArtifact["review"]["ambiguousAirportRows"] = [];
  const candidates: Array<{
    flight: MyFlightRadar24Flight;
    origin?: Extract<AirportResolution, { status: "resolved" }>;
    destination?: Extract<AirportResolution, { status: "resolved" }>;
  }> = [];

  for (const flight of parsed.flights) {
    const errors = flight.issues.filter((issue) => issue.severity === "error");
    if (
      errors.length > 0 ||
      !flight.date ||
      !flight.originIdentifier ||
      !flight.destinationIdentifier
    ) {
      invalidRows.push({
        sourceRowNumber: flight.sourceRowNumber,
        issueCodes: errors.map((issue) => issue.code),
      });
      candidates.push({ flight });
      continue;
    }

    const originResolution = resolveAirportPair(
      resolveAirport,
      flight.originIcaoIdentifier,
      flight.originIdentifier,
    );
    const destinationResolution = resolveAirportPair(
      resolveAirport,
      flight.destinationIcaoIdentifier,
      flight.destinationIdentifier,
    );
    const unresolved = [
      originResolution.status === "not-found"
        ? { field: "From", identifier: flight.originIdentifier }
        : undefined,
      destinationResolution.status === "not-found"
        ? { field: "To", identifier: flight.destinationIdentifier }
        : undefined,
    ].filter((item): item is { field: string; identifier: string } => Boolean(item));
    const ambiguous = [
      originResolution.status === "ambiguous"
        ? { field: "From", identifier: flight.originIdentifier }
        : undefined,
      destinationResolution.status === "ambiguous"
        ? { field: "To", identifier: flight.destinationIdentifier }
        : undefined,
    ].filter((item): item is { field: string; identifier: string } => Boolean(item));

    if (unresolved.length > 0) {
      unresolvedAirportRows.push({
        sourceRowNumber: flight.sourceRowNumber,
        fields: unresolved.map((item) => item.field),
        identifiers: unresolved.map((item) => item.identifier),
      });
    }
    if (ambiguous.length > 0) {
      ambiguousAirportRows.push({
        sourceRowNumber: flight.sourceRowNumber,
        fields: ambiguous.map((item) => item.field),
        identifiers: ambiguous.map((item) => item.identifier),
      });
    }
    candidates.push({
      flight,
      origin: originResolution.status === "resolved" ? originResolution : undefined,
      destination:
        destinationResolution.status === "resolved" ? destinationResolution : undefined,
    });
  }

  const mapReadyCandidates = candidates.filter(
    (
      candidate,
    ): candidate is typeof candidate & {
      origin: Extract<AirportResolution, { status: "resolved" }>;
      destination: Extract<AirportResolution, { status: "resolved" }>;
      flight: MyFlightRadar24Flight & { date: string };
    } => Boolean(candidate.flight.date && candidate.origin && candidate.destination),
  );
  const normalizedFlights: NormalizedFlight[] = mapReadyCandidates.map(
    ({ flight, origin, destination }) => ({
      userId: "local-preview",
      departureDate: flight.date,
      departureTime: flight.departureTime,
      originCode: origin.airport.code,
      destinationCode: destination.airport.code,
      kind: "commercial",
      role: "passenger",
      aircraft: normalizeAircraftMetadata(flight.aircraftModel),
      flightNumber: flight.flightNumber,
      sourceRecordId: flight.provenance.idempotencyKey,
    }),
  );
  const duplicateAssessments = assessDuplicateCandidates(normalizedFlights);
  const comparisonFlights: NormalizedFlight[] = (metadata.comparisonFlights ?? []).map(
    (flight) => ({
      userId: "local-preview",
      departureDate: flight.date,
      departureTime: flight.departureTime,
      originCode: flight.origin.code,
      destinationCode: flight.destination.code,
      kind: flight.kind,
      role: flight.role,
      aircraft: flight.aircraft,
      flightNumber: flight.flightNumber,
      sourceRecordId: flight.id,
    }),
  );
  const roleDistinctOverlaps = findRoleDistinctOverlaps([
    ...normalizedFlights,
    ...comparisonFlights,
  ]);
  const assessmentByRow = new Map<number, DuplicateAssessment>();
  duplicateAssessments.forEach((assessment) => {
    assessmentByRow.set(mapReadyCandidates[assessment.index].flight.sourceRowNumber, assessment);
  });

  const flights: MyFlightRadar24MapFlight[] = mapReadyCandidates.map(
    ({ flight, origin, destination }) => {
      const assessment = assessmentByRow.get(flight.sourceRowNumber);
      const aircraftModel = normalizeAircraftMetadata(flight.aircraftModel);
      const registration = normalizeRegistrationMetadata(flight.registration);
      return {
        id: `fr24-${flight.provenance.idempotencyKey.slice(0, 16)}`,
        date: flight.date,
        departureTime: flight.departureTime,
        origin: origin.airport,
        destination: destination.airport,
        kind: "commercial",
        role: "passenger",
        aircraft: aircraftModel ?? "Aircraft not specified",
        ...(aircraftModel ? { aircraftModel } : {}),
        ...(registration ? { registration } : {}),
        flightNumber: flight.flightNumber,
        airline: flight.airline ?? flight.airlineCode,
        distanceMiles: greatCircleStatuteMiles(origin.airport, destination.airport),
        source: "FlightRadar24",
        reconciliation: assessment
          ? {
              status:
                assessment.confidence === "exact"
                  ? "exact-duplicate-candidate"
                  : "ambiguous-duplicate-candidate",
              candidateOfRowNumber:
                mapReadyCandidates[assessment.candidateOfIndex].flight.sourceRowNumber,
              rule: assessment.rule,
            }
          : { status: "unique" },
        provenance: flight.provenance,
      };
    },
  );

  const airportByCode = new Map<string, Airport>();
  for (const flight of flights) {
    airportByCode.set(flight.origin.code, flight.origin);
    airportByCode.set(flight.destination.code, flight.destination);
  }
  const routes = aggregateRoutesFromFlights(flights);
  const mapFlightByRow = new Map(
    flights.map((flight) => [flight.provenance.sourceRowNumber, flight]),
  );
  const statsFacts = parsed.flights.flatMap((flight): StatsFact[] => {
    if (!flight.date) return [];
    const mapFlight = mapFlightByRow.get(flight.sourceRowNumber);
    const assessment = assessmentByRow.get(flight.sourceRowNumber);
    return [{
      id:
        mapFlight?.id ??
        `fr24-stat-${flight.provenance.idempotencyKey.slice(0, 16)}`,
      date: flight.date,
      kind: "commercial",
      role: "passenger",
      activity: "flight",
      source: "FlightRadar24",
      mapReady: Boolean(mapFlight),
      originCode: mapFlight?.origin.code,
      destinationCode: mapFlight?.destination.code,
      dedupeStatus:
        assessment?.confidence === "exact"
          ? "exact-duplicate"
          : assessment?.confidence === "ambiguous"
            ? "ambiguous"
            : "unique",
      durationHours:
        flight.durationMinutes === undefined
          ? undefined
          : Number((flight.durationMinutes / 60).toFixed(6)),
      durationStatus:
        flight.durationMinutes === undefined ? "invalid" : "known",
      hobbsStatus: "missing",
      distanceMiles: mapFlight?.distanceMiles,
      distanceStatus: "missing",
      distanceBasis: mapFlight ? "great-circle" : undefined,
    }];
  });

  return {
    schemaVersion: MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION,
    statsFactSchemaVersion: STATS_FACT_SCHEMA_VERSION,
    generatedAt: metadata.generatedAt,
    sourceLabel: "Local myFlightradar24 import",
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
      roleDistinctOverlapCandidates: roleDistinctOverlaps.length,
    },
    airports: [...airportByCode.values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    ),
    flights,
    statsFacts,
    routes: routes.toSorted((left, right) => left.id.localeCompare(right.id)),
    review: {
      invalidRows,
      unresolvedAirportRows,
      ambiguousAirportRows,
      duplicateCandidates: duplicateAssessments.map((assessment) => ({
        sourceRowNumber: mapReadyCandidates[assessment.index].flight.sourceRowNumber,
        candidateOfRowNumber:
          mapReadyCandidates[assessment.candidateOfIndex].flight.sourceRowNumber,
        confidence: assessment.confidence,
        rule: assessment.rule,
      })),
    },
  };
}
