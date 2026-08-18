import "server-only";

import fs from "node:fs";
import path from "node:path";
import type { Airport, Flight, FlightKind, MapRoute } from "./flight-data";
import { aggregateRoutesFromFlights } from "./route-aggregation";
import { STATS_FACT_SCHEMA_VERSION } from "./flight-statistics";
import {
  LOCAL_MAP_ARTIFACT_VERSION,
  type LocalMapArtifact,
} from "./import/map-artifact";
import {
  MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION,
  type MyFlightRadar24MapArtifact,
} from "./import/myflightradar24-artifact";

export type LocalFlightData = {
  authoritative?: boolean;
  generatedAt: string;
  sourceLabel: string;
  importedKinds: FlightKind[];
  stats: {
    records: number;
    flights: number;
    airports: number;
    distanceMiles: number;
    routes: number;
    mappedFlights: number;
  };
  airports: Airport[];
  routes: MapRoute[];
  flights: Flight[];
  recentFlights: Flight[];
};

const foreFlightDataPath = path.join(process.cwd(), "data", "private", "local-flights.json");
const fr24DataPath = path.join(process.cwd(), "data", "private", "fr24-flights.json");

type SupportedArtifact = LocalMapArtifact | MyFlightRadar24MapArtifact;

function readArtifact(filePath: string, expectedVersion: number): SupportedArtifact | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as SupportedArtifact;
    if (
      parsed.schemaVersion !== expectedVersion ||
      parsed.statsFactSchemaVersion !== STATS_FACT_SCHEMA_VERSION ||
      !Array.isArray(parsed.airports) ||
      !Array.isArray(parsed.routes) ||
      !Array.isArray(parsed.flights) ||
      !Array.isArray(parsed.statsFacts) ||
      typeof parsed.summary?.importedRows !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getLocalFlightData(): LocalFlightData | null {
  const artifacts = [
    readArtifact(foreFlightDataPath, LOCAL_MAP_ARTIFACT_VERSION),
    readArtifact(fr24DataPath, MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION),
  ].filter((artifact): artifact is SupportedArtifact => Boolean(artifact));
  if (artifacts.length === 0) return null;

  const flights: Flight[] = artifacts.flatMap((artifact) =>
    artifact.flights.map(toMapSafeFlight),
  );
  const routes = aggregateRoutesFromFlights(flights);
  const airportByCode = new Map(
    artifacts
      .flatMap((artifact) => artifact.airports)
      .map((airport) => [airport.code, airport]),
  );
  const recentFlights: Flight[] = (["commercial", "private"] as const)
    .flatMap((kind) =>
      flights
        .filter((flight) => flight.kind === kind)
        .toSorted((left, right) => right.date.localeCompare(left.date))
        .slice(0, 30),
    )
      .toSorted((left, right) => right.date.localeCompare(left.date))
      .map((flight) => ({
        id: flight.id,
        date: flight.date,
        departureTime: flight.departureTime,
        origin: flight.origin,
        destination: flight.destination,
        kind: flight.kind,
        role: flight.role,
        aircraft: flight.aircraft,
        aircraftType: flight.aircraftType,
        aircraftModel: flight.aircraftModel,
        registration: flight.registration,
        flightNumber: flight.flightNumber,
        airline: flight.airline,
        distanceMiles: flight.distanceMiles,
        source: flight.source,
      }));
  const importedKinds = Array.from(
    new Set(artifacts.flatMap((artifact) => artifact.routes.map((route) => route.kind))),
  );

  return {
    generatedAt: artifacts.map((artifact) => artifact.generatedAt).sort().at(-1) ?? "",
    sourceLabel:
      artifacts.length === 2
        ? "Local ForeFlight and myFlightradar24 imports"
        : artifacts[0].sourceLabel,
    importedKinds,
    stats: {
      records: artifacts.reduce(
        (total, artifact) =>
          total +
          artifact.statsFacts.filter(
            (fact) => fact.dedupeStatus !== "exact-duplicate",
          ).length,
        0,
      ),
      flights: artifacts.reduce(
        (total, artifact) =>
          total +
          artifact.statsFacts.filter(
            (fact) =>
              fact.activity === "flight" &&
              fact.dedupeStatus !== "exact-duplicate",
          ).length,
        0,
      ),
      mappedFlights: flights.length,
      airports: airportByCode.size,
      routes: routes.length,
      distanceMiles: Math.round(
        flights.reduce((total, flight) => total + flight.distanceMiles, 0),
      ),
    },
    airports: [...airportByCode.values()],
    routes,
    flights,
    recentFlights,
  };
}

function toMapSafeFlight(flight: Flight): Flight {
  return {
    id: flight.id,
    date: flight.date,
    departureTime: flight.departureTime,
    origin: flight.origin,
    destination: flight.destination,
    kind: flight.kind,
    role: flight.role,
    aircraft: flight.aircraft,
    aircraftType: flight.aircraftType,
    aircraftModel: flight.aircraftModel,
    registration: flight.registration,
    flightNumber: flight.flightNumber,
    airline: flight.airline,
    distanceMiles: flight.distanceMiles,
    source: flight.source,
  };
}
