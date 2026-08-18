import "server-only";

import fs from "node:fs";
import path from "node:path";
import {
  aggregateFlightStatistics,
  type CivilDate,
  type FlightStatisticsResult,
  resolveStatsPeriod,
  STATS_FACT_SCHEMA_VERSION,
  type StatsFact,
  type StatsQuery,
} from "./flight-statistics";
import {
  LOCAL_MAP_ARTIFACT_VERSION,
  type LocalMapArtifact,
} from "./import/map-artifact";
import {
  MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION,
  type MyFlightRadar24MapArtifact,
} from "./import/myflightradar24-artifact";

const privateDirectory = path.join(process.cwd(), "data", "private");

export type LocalFlightStatisticsContext = {
  facts: StatsFact[];
  asOfDate: CivilDate;
  timeZone: string;
};

export function getLocalFlightStatistics(
  query: StatsQuery,
): FlightStatisticsResult | null {
  const facts = readAllStatsFacts();

  return facts.length === 0 ? null : aggregateFlightStatistics(facts, query);
}

export function getLocalFlightStatisticsContext(): LocalFlightStatisticsContext {
  const facts = readAllStatsFacts();
  const resolved = resolveStatsPeriod({ period: "this-year" });
  return {
    facts,
    asOfDate: resolved.asOfDate,
    timeZone: resolved.timeZone,
  };
}

function readAllStatsFacts(): StatsFact[] {
  return [
    readStatsFacts<LocalMapArtifact>(
      path.join(privateDirectory, "local-flights.json"),
      LOCAL_MAP_ARTIFACT_VERSION,
    ),
    readStatsFacts<MyFlightRadar24MapArtifact>(
      path.join(privateDirectory, "fr24-flights.json"),
      MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION,
    ),
  ].flatMap((value) => value ?? []);
}

function readStatsFacts<
  T extends {
    schemaVersion: number;
    statsFactSchemaVersion: number;
    statsFacts: StatsFact[];
  },
>(
  filePath: string,
  expectedVersion: number,
): StatsFact[] | null {
  try {
    const artifact = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    if (
      artifact.schemaVersion !== expectedVersion ||
      artifact.statsFactSchemaVersion !== STATS_FACT_SCHEMA_VERSION ||
      !Array.isArray(artifact.statsFacts)
    ) {
      return null;
    }
    return artifact.statsFacts;
  } catch {
    return null;
  }
}
