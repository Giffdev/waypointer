import { randomUUID } from "node:crypto";
import {
  LOCAL_MAP_ARTIFACT_VERSION,
  type LocalMapArtifact,
} from "./map-artifact";
import {
  MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION,
  type MyFlightRadar24MapArtifact,
} from "./myflightradar24-artifact";
import { STATS_FACT_SCHEMA_VERSION } from "../flight-statistics";
import type { ImportWorkerRepositories } from "./worker";
import { applyDuplicateCandidates } from "./dedupe";
import { createFileFingerprint, createRowFingerprint } from "./fingerprint";
import type {
  ImportBatchSummary,
  ImportAirportMatch,
  ProposedImportFlight,
  StoredImportRow,
  UploadImportResponse,
} from "./types";

export const LOCAL_ARTIFACT_MIGRATION_VERSION = 1 as const;

export type SupportedArtifact = LocalMapArtifact | MyFlightRadar24MapArtifact;

export class LocalArtifactValidationError extends Error {
  constructor(readonly code: string) {
    super("The local artifact failed validation.");
    this.name = "LocalArtifactValidationError";
  }
}

export type LocalArtifactMigrationPlan = {
  artifactType: "foreflight" | "fr24";
  source: "ForeFlight" | "FlightRadar24";
  fileFingerprint: ReturnType<typeof createFileFingerprint>;
  existingBatch?: ImportBatchSummary;
  rows: StoredImportRow[];
  issueCodes: string[];
};

export function validateLocalArtifact(input: unknown): SupportedArtifact {
  const artifact = object(input, "invalid-artifact");
  const schemaVersion = integer(artifact.schemaVersion, "invalid-schema-version");
  const artifactType =
    schemaVersion === LOCAL_MAP_ARTIFACT_VERSION
      ? "foreflight"
      : schemaVersion === MY_FLIGHTRADAR24_MAP_ARTIFACT_VERSION
        ? "fr24"
        : undefined;
  if (!artifactType) throw new LocalArtifactValidationError("unsupported-schema-version");
  if (
    integer(artifact.statsFactSchemaVersion, "invalid-stats-schema-version") !==
    STATS_FACT_SCHEMA_VERSION
  ) {
    throw new LocalArtifactValidationError("unsupported-stats-schema-version");
  }
  const generatedAt = nonEmptyString(
    artifact.generatedAt,
    "invalid-generated-at",
  );
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new LocalArtifactValidationError("invalid-generated-at");
  }
  nonEmptyString(artifact.sourceLabel, "invalid-source-label");
  const source = object(artifact.source, "invalid-source");
  const sourceAdapter = nonEmptyString(
    source.adapter,
    "invalid-source-adapter",
  );
  const sourceAdapterVersion = positiveInteger(
    source.adapterVersion,
    "invalid-adapter-version",
  );
  if (!/^[0-9a-f]{64}$/i.test(nonEmptyString(source.sourceFileSha256, "invalid-source-hash"))) {
    throw new LocalArtifactValidationError("invalid-source-hash");
  }
  nonEmptyString(source.airportDataset, "invalid-airport-dataset");
  const summary = object(artifact.summary, "invalid-summary");
  const importedRows = nonNegativeInteger(
    summary.importedRows,
    "invalid-imported-count",
  );
  const mapReadyFlights = nonNegativeInteger(
    summary.mapReadyFlights,
    "invalid-ready-count",
  );
  for (const key of [
    "invalidRows",
    "unresolvedAirportRows",
    "ambiguousAirportRows",
    "exactDuplicateCandidates",
    "ambiguousDuplicateCandidates",
  ]) {
    nonNegativeInteger(summary[key], "invalid-summary");
  }
  if (artifactType === "fr24") {
    nonNegativeInteger(
      summary.roleDistinctOverlapCandidates,
      "invalid-summary",
    );
  }
  const flights = array(artifact.flights, "invalid-flights");
  if (flights.length !== mapReadyFlights || importedRows < flights.length) {
    throw new LocalArtifactValidationError("inconsistent-flight-counts");
  }
  array(artifact.airports, "invalid-airports");
  array(artifact.routes, "invalid-routes");
  array(artifact.statsFacts, "invalid-stats-facts");
  const review = object(artifact.review, "invalid-review");
  array(review.invalidRows, "invalid-review-rows");
  array(review.unresolvedAirportRows, "invalid-review-rows");
  array(review.ambiguousAirportRows, "invalid-review-rows");
  array(review.duplicateCandidates, "invalid-review-rows");
  if (artifactType === "foreflight") {
    array(artifact.recentFlights, "invalid-recent-flights");
    object(artifact.stats, "invalid-stats");
  }

  const rowNumbers = new Set<number>();
  const stableIds = new Set<string>();
  for (const value of flights) {
    const flight = object(value, "invalid-flight");
    nonEmptyString(flight.id, "invalid-flight-id");
    dateString(flight.date);
    const origin = airportObject(flight.origin);
    const destination = airportObject(flight.destination);
    if (!origin.code || !destination.code) {
      throw new LocalArtifactValidationError("invalid-flight-airport");
    }
    const provenance = object(flight.provenance, "invalid-provenance");
    if (
      provenance.adapter !== sourceAdapter ||
      provenance.adapterVersion !== sourceAdapterVersion
    ) {
      throw new LocalArtifactValidationError("source-adapter-mismatch");
    }
    const rowNumber = positiveInteger(
      provenance.sourceRowNumber,
      "invalid-source-row",
    );
    const stableId = nonEmptyString(
      provenance.idempotencyKey,
      "invalid-idempotency-key",
    );
    if (rowNumbers.has(rowNumber) || stableIds.has(stableId)) {
      throw new LocalArtifactValidationError("duplicate-source-identity");
    }
    rowNumbers.add(rowNumber);
    stableIds.add(stableId);
    const expectedSource =
      artifactType === "foreflight" ? "ForeFlight" : "FlightRadar24";
    if (flight.source !== expectedSource || provenance.source !== expectedSource) {
      throw new LocalArtifactValidationError("source-type-mismatch");
    }
  }
  return artifact as unknown as SupportedArtifact;
}

export async function planLocalArtifactMigration(
  userId: string,
  artifact: SupportedArtifact,
  repositories: ImportWorkerRepositories,
): Promise<LocalArtifactMigrationPlan> {
  if (!userId.trim()) throw new Error("A userId is required");
  const artifactType =
    artifact.schemaVersion === LOCAL_MAP_ARTIFACT_VERSION
      ? "foreflight"
      : "fr24";
  const sourceIdentity = sourceIdentityFor(artifact);
  const fileFingerprint = createFileFingerprint(userId, sourceIdentity);
  const existingBatch =
    (await repositories.imports.findBatchByFileFingerprint(
      userId,
      fileFingerprint,
    )) ?? undefined;
  if (existingBatch) {
    return {
      artifactType,
      source: sourceFor(artifact),
      fileFingerprint,
      existingBatch,
      rows: [],
      issueCodes: [],
    };
  }
  const batchId = randomUUID();
  const rows = await buildMigrationRows(userId, batchId, artifact, repositories);
  const existingCandidates =
    await repositories.flights.findDuplicateCandidates(userId, rows);
  const staged = applyDuplicateCandidates(rows, existingCandidates);
  return {
    artifactType,
    source: sourceFor(artifact),
    fileFingerprint,
    rows: staged,
    issueCodes: safeIssueCodes(staged),
  };
}

export async function stageLocalArtifactMigration(
  userId: string,
  artifact: SupportedArtifact,
  repositories: ImportWorkerRepositories,
): Promise<UploadImportResponse> {
  const plan = await planLocalArtifactMigration(userId, artifact, repositories);
  if (plan.existingBatch) {
    return {
      batchId: plan.existingBatch.id,
      status: responseStatus(plan.existingBatch.status),
      reused: true,
    };
  }

  const batchId = plan.rows[0]?.batchId ?? randomUUID();
  const batch = await repositories.imports.createBatch(userId, {
    id: batchId,
    fileName: `local-${plan.source.toLowerCase()}-preview.json`,
    fileSizeBytes: sourceIdentityFor(artifact).length,
    fileFingerprint: plan.fileFingerprint,
    status: "processing",
  });
  const completed = await repositories.imports.completeStaging(
    userId,
    batch.id,
    {
      adapterId: `local-artifact-v${LOCAL_ARTIFACT_MIGRATION_VERSION}`,
      adapterLabel: artifact.source.adapter,
      adapterVersion: artifact.source.adapterVersion,
      source: plan.source,
      rows: plan.rows,
    },
  );
  return {
    batchId: completed.id,
    status: responseStatus(completed.status),
    reused: false,
  };
}

async function buildMigrationRows(
  userId: string,
  batchId: string,
  artifact: SupportedArtifact,
  repositories: ImportWorkerRepositories,
): Promise<StoredImportRow[]> {
  return Promise.all(
    artifact.flights.map(async (flight): Promise<StoredImportRow> => {
      const origin = await repositories.airports.resolveIdentifier(
        userId,
        flight.origin.code,
      );
      const destination = await repositories.airports.resolveIdentifier(
        userId,
        flight.destination.code,
      );
      const proposedFlight: ProposedImportFlight = {
        date: flight.date,
        departureTime: flight.departureTime,
        originIdentifier: flight.origin.code,
        destinationIdentifier: flight.destination.code,
        origin,
        destination,
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
      const commitReady =
        origin.status === "resolved" && destination.status === "resolved";
      return {
        id: randomUUID(),
        batchId,
        rowNumber: flight.provenance.sourceRowNumber,
        rawSnapshot: null,
        proposedFlight,
        issues: [],
        validationState: commitReady
          ? "ready"
          : resolutionState(origin, destination),
        commitReady,
        decision: "pending",
        rowFingerprint: commitReady
          ? createRowFingerprint(userId, proposedFlight)
          : undefined,
        provenance: {
          adapterId: `local-artifact-v${LOCAL_ARTIFACT_MIGRATION_VERSION}`,
          adapterLabel: artifact.source.adapter,
          adapterVersion: artifact.source.adapterVersion,
          source: flight.source,
          sourceRowNumber: flight.provenance.sourceRowNumber,
          externalStableId: flight.provenance.idempotencyKey,
        },
      };
    }),
  );
}

function sourceIdentityFor(artifact: SupportedArtifact): string {
  return [
    `local-artifact-migration-v${LOCAL_ARTIFACT_MIGRATION_VERSION}`,
    artifact.source.adapter,
    artifact.source.adapterVersion,
    artifact.source.sourceFileSha256,
  ].join("\u001f");
}

function sourceFor(
  artifact: SupportedArtifact,
): "ForeFlight" | "FlightRadar24" {
  return artifact.schemaVersion === LOCAL_MAP_ARTIFACT_VERSION
    ? "ForeFlight"
    : "FlightRadar24";
}

function safeIssueCodes(rows: StoredImportRow[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.validationState === "unresolved"
          ? ["unresolved-airport"]
          : []),
        ...(row.validationState === "ambiguous"
          ? ["ambiguous-airport"]
          : []),
        ...(row.validationState === "invalid" ? ["invalid-flight"] : []),
        ...(row.duplicateCandidate ? ["duplicate-candidate"] : []),
      ]),
    ),
  ].sort();
}

function resolutionState(
  origin: ImportAirportMatch,
  destination: ImportAirportMatch,
): "ambiguous" | "unresolved" {
  return origin.status === "ambiguous" || destination.status === "ambiguous"
    ? "ambiguous"
    : "unresolved";
}

function responseStatus(
  status: string,
): UploadImportResponse["status"] {
  return status === "review" ||
    status === "failed" ||
    status === "committed"
    ? status
    : "processing";
}

function object(
  value: unknown,
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalArtifactValidationError(code);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new LocalArtifactValidationError(code);
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new LocalArtifactValidationError(code);
  return value as number;
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = integer(value, code);
  if (parsed < 1) throw new LocalArtifactValidationError(code);
  return parsed;
}

function nonNegativeInteger(value: unknown, code: string): number {
  const parsed = integer(value, code);
  if (parsed < 0) throw new LocalArtifactValidationError(code);
  return parsed;
}

function nonEmptyString(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LocalArtifactValidationError(code);
  }
  return value;
}

function dateString(value: unknown): string {
  const parsed = nonEmptyString(value, "invalid-flight-date");
  const date = new Date(`${parsed}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== parsed
  ) {
    throw new LocalArtifactValidationError("invalid-flight-date");
  }
  return parsed;
}

function airportObject(value: unknown): Record<string, unknown> {
  const airport = object(value, "invalid-flight-airport");
  nonEmptyString(airport.code, "invalid-flight-airport");
  nonEmptyString(airport.name, "invalid-flight-airport");
  nonEmptyString(airport.city, "invalid-flight-airport");
  nonEmptyString(airport.country, "invalid-flight-airport");
  nonEmptyString(airport.facility, "invalid-flight-airport");
  if (
    typeof airport.lat !== "number" ||
    !Number.isFinite(airport.lat) ||
    typeof airport.lon !== "number" ||
    !Number.isFinite(airport.lon)
  ) {
    throw new LocalArtifactValidationError("invalid-flight-airport");
  }
  return airport;
}
