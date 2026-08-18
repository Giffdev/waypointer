import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAirportResolver,
  OURAIRPORTS_SOURCE_URL,
  parseOurAirportsCsv,
} from "../src/lib/import/airport-resolution.ts";
import { buildMyFlightRadar24MapArtifact } from "../src/lib/import/myflightradar24-artifact.ts";
import { parseFlightImport } from "../src/lib/import/registry.ts";
import {
  LOCAL_MAP_ARTIFACT_VERSION,
  type LocalMapArtifact,
} from "../src/lib/import/map-artifact.ts";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const PRIVATE_DIRECTORY = path.resolve("data", "private");
const DEFAULT_OUTPUT = path.join(PRIVATE_DIRECTORY, "fr24-flights.json");
const DEFAULT_AIRPORT_CACHE = path.join(
  PRIVATE_DIRECTORY,
  "reference",
  "ourairports-airports.csv",
);
const DEFAULT_FOREFLIGHT_ARTIFACT = path.join(PRIVATE_DIRECTORY, "local-flights.json");

function privatePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(PRIVATE_DIRECTORY, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Output and airport cache paths must remain under data/private");
  }
  return resolved;
}

async function findDefaultSource(): Promise<string> {
  const matches = (await readdir(process.cwd()))
    .filter((name) => /^flightdiary_.*\.csv$/i.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ignored flightdiary_*.csv file; found ${matches.length}. Pass a source path explicitly.`,
    );
  }
  return path.resolve(matches[0]);
}

function parseArguments(): {
  source?: string;
  output?: string;
  airportCache?: string;
  offline: boolean;
} {
  const parsed: {
    source?: string;
    output?: string;
    airportCache?: string;
    offline: boolean;
  } = { offline: false };
  const argumentsToParse = process.argv.slice(2);

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--offline") {
      parsed.offline = true;
      continue;
    }
    if (argument === "--output" || argument === "--airport-cache") {
      const optionValue = argumentsToParse[index + 1];
      if (!optionValue || optionValue.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === "--output") parsed.output = optionValue;
      else parsed.airportCache = optionValue;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    if (parsed.source) throw new Error("Only one source CSV path may be provided");
    parsed.source = argument;
  }
  return parsed;
}

async function loadAirportDataset(cachePath: string, offline: boolean): Promise<string> {
  try {
    return await readFile(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (offline) {
    throw new Error("Airport reference cache is missing and --offline was requested");
  }

  console.log("Downloading the public OurAirports reference dataset (no diary data is sent)...");
  const response = await fetch(OURAIRPORTS_SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Airport reference download failed with HTTP ${response.status}`);
  }
  const contents = await response.text();
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, contents, "utf8");
  return contents;
}

async function main() {
  const argumentsToUse = parseArguments();
  const sourcePath = argumentsToUse.source
    ? path.resolve(argumentsToUse.source)
    : await findDefaultSource();
  const outputPath = privatePath(argumentsToUse.output ?? DEFAULT_OUTPUT);
  const airportCachePath = privatePath(argumentsToUse.airportCache ?? DEFAULT_AIRPORT_CACHE);

  const sourceStats = await stat(sourcePath);
  if (sourceStats.size > MAX_SOURCE_BYTES) {
    throw new Error(`Source CSV exceeds the ${MAX_SOURCE_BYTES / 1024 / 1024} MB local limit`);
  }

  const [sourceCsv, airportCsv] = await Promise.all([
    readFile(sourcePath, "utf8"),
    loadAirportDataset(airportCachePath, argumentsToUse.offline),
  ]);
  let comparisonFlights: LocalMapArtifact["flights"] = [];
  try {
    const parsedArtifact = JSON.parse(
      await readFile(DEFAULT_FOREFLIGHT_ARTIFACT, "utf8"),
    ) as LocalMapArtifact;
    if (
      parsedArtifact.schemaVersion === LOCAL_MAP_ARTIFACT_VERSION &&
      Array.isArray(parsedArtifact.flights)
    ) {
      comparisonFlights = parsedArtifact.flights;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dispatch = parseFlightImport(sourceCsv);
  if (dispatch.status !== "parsed") {
    throw new Error(dispatch.reason);
  }
  if (dispatch.adapterId !== "myflightradar24-v1") {
    throw new Error(
      `Detected ${dispatch.label}; the myFlightradar24 artifact command did not run.`,
    );
  }
  const parsed = dispatch.parsed;
  const references = parseOurAirportsCsv(airportCsv);
  const latestDate = parsed.flights
    .flatMap((flight) => (flight.date ? [flight.date] : []))
    .sort()
    .at(-1);
  const artifact = buildMyFlightRadar24MapArtifact(
    parsed,
    createAirportResolver(references),
    {
      generatedAt: `${latestDate ?? "1970-01-01"}T00:00:00.000Z`,
      sourceFileSha256: createHash("sha256").update(sourceCsv).digest("hex"),
      airportDataset: OURAIRPORTS_SOURCE_URL,
      comparisonFlights,
    },
  );
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  let unchanged = false;
  try {
    unchanged = (await readFile(outputPath, "utf8")) === serialized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!unchanged) await writeFile(outputPath, serialized, "utf8");

  console.log(
    `${unchanged ? "Verified" : "Wrote"} ignored map artifact: ${path.relative(process.cwd(), outputPath)}`,
  );
  console.log(
    [
      `${artifact.summary.importedRows} imported`,
      `${artifact.summary.mapReadyFlights} map-ready`,
      `${artifact.summary.invalidRows} invalid`,
      `${artifact.summary.unresolvedAirportRows} unresolved-airport`,
      `${artifact.summary.ambiguousAirportRows} ambiguous-airport`,
      `${artifact.summary.exactDuplicateCandidates} exact-duplicate candidates`,
      `${artifact.summary.ambiguousDuplicateCandidates} ambiguous-duplicate candidates`,
      `${artifact.summary.roleDistinctOverlapCandidates} role-distinct overlap candidates`,
    ].join("; "),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "myFlightradar24 import failed");
  process.exitCode = 1;
});
