import { randomUUID } from "node:crypto";
import type { AirportRepository } from "@/lib/db/repositories/airport-repository";
import type { FlightRepository } from "@/lib/db/repositories/flight-repository";
import type { ImportRepository } from "@/lib/db/repositories/import-repository";
import { parseCsv, detectCsvDelimiter } from "./csv";
import { applyDuplicateCandidates } from "./dedupe";
import {
  assignSourceRowKeys,
  createFileFingerprint,
  createLegacyRowFingerprint,
  createRowFingerprint,
} from "./fingerprint";
import { normalizeFlightRoute } from "./route-normalization";
import {
  parseMappedGenericCsv,
  type GenericCsvMapping,
  type GenericCsvParseResult,
} from "./generic-csv";
import { parseFlightImport, type ParsedFlightImport } from "./registry";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "./review";
import type {
  ImportAirportMatch,
  ImportBatchSummary,
  ImportIssue,
  ProposedImportFlight,
  StoredImportRow,
  UploadImportResponse,
} from "./types";
import { sourceRoleDefault } from "../flight-role";
import { CSV_MIME_TYPES } from "./csv-mime";

export const DEFAULT_MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// Shared with the client preview gate, synchronous upload service, and
// durable upload service; see src/lib/import/csv-mime.ts for why this must
// stay in sync across all call sites. "" is included locally because a
// blank declared content type is accepted as-is here (the durable worker
// normalizes it upstream, but this worker is also exercised directly by
// unit tests with blank/omitted MIME types).
const ACCEPTED_MIME_TYPES = new Set<string>(["", ...CSV_MIME_TYPES]);

export type FlightImportUpload = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  content: string;
  originalObjectKey?: string;
};

export type ImportWorkerRepositories = {
  imports: ImportRepository;
  flights: FlightRepository;
  airports: AirportRepository;
};

export async function stageFlightImport(
  userId: string,
  upload: FlightImportUpload,
  repositories: ImportWorkerRepositories,
  options: { maxBytes?: number } = {},
): Promise<UploadImportResponse> {
  validateUpload(userId, upload, options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES);
  const fileFingerprint = createFileFingerprint(userId, upload.content);
  const existing = await repositories.imports.findBatchByFileFingerprint(
    userId,
    fileFingerprint,
  );
  if (existing) return uploadResponse(existing, true);

  const requestedBatchId = randomUUID();
  const createdBatch = await repositories.imports.createBatch(userId, {
    id: requestedBatchId,
    fileName: upload.fileName,
    fileSizeBytes: upload.sizeBytes,
    fileFingerprint,
    originalObjectKey: upload.originalObjectKey,
    status: "processing",
  });
  if (createdBatch.id !== requestedBatchId) {
    return uploadResponse(createdBatch, true);
  }
  const batchId = createdBatch.id;
  return stageCreatedBatch(userId, batchId, upload, repositories);
}

export async function stageExistingFlightImport(
  userId: string,
  batchId: string,
  upload: FlightImportUpload,
  repositories: ImportWorkerRepositories,
  options: { maxBytes?: number } = {},
): Promise<UploadImportResponse> {
  validateUpload(userId, upload, options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES);
  return stageCreatedBatch(userId, batchId, upload, repositories);
}

export async function stageMappedFlightImport(
  userId: string,
  upload: FlightImportUpload,
  mapping: GenericCsvMapping,
  repositories: ImportWorkerRepositories,
  options: { maxBytes?: number } = {},
): Promise<UploadImportResponse> {
  validateUpload(userId, upload, options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES);
  const fileFingerprint = createFileFingerprint(userId, upload.content);
  const existing = await repositories.imports.findBatchByFileFingerprint(
    userId,
    fileFingerprint,
  );
  if (existing) return uploadResponse(existing, true);
  const requestedBatchId = randomUUID();
  const createdBatch = await repositories.imports.createBatch(userId, {
    id: requestedBatchId,
    fileName: upload.fileName,
    fileSizeBytes: upload.sizeBytes,
    fileFingerprint,
    originalObjectKey: upload.originalObjectKey,
    status: "processing",
  });
  if (createdBatch.id !== requestedBatchId) {
    return uploadResponse(createdBatch, true);
  }
  return stageCreatedMappedBatch(
    userId,
    createdBatch.id,
    upload,
    mapping,
    repositories,
  );
}

export async function stageExistingMappedFlightImport(
  userId: string,
  batchId: string,
  upload: FlightImportUpload,
  mapping: GenericCsvMapping,
  repositories: ImportWorkerRepositories,
  options: { maxBytes?: number } = {},
): Promise<UploadImportResponse> {
  validateUpload(userId, upload, options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES);
  return stageCreatedMappedBatch(userId, batchId, upload, mapping, repositories);
}

async function stageCreatedBatch(
  userId: string,
  batchId: string,
  upload: FlightImportUpload,
  repositories: ImportWorkerRepositories,
): Promise<UploadImportResponse> {
  const parsed = parseFlightImport(upload.content);
  if (parsed.status !== "parsed") {
    const failed = await repositories.imports.failBatch(userId, batchId, {
      code: parsed.status === "invalid" ? parsed.errorCode : parsed.status,
      message: parsed.reason,
    });
    return uploadResponse(failed, false);
  }

  try {
    const rows = await mapParsedRows(
      userId,
      batchId,
      upload.content,
      parsed,
      repositories.airports,
    );
    const existingCandidates =
      await repositories.flights.findDuplicateCandidates(userId, rows);
    const stagedRows = applyDuplicateCandidates(rows, existingCandidates);
    const adapterVersion = parsed.parsed.adapter.version;
    const batch = await repositories.imports.completeStaging(userId, batchId, {
      adapterId: parsed.adapterId,
      adapterLabel: parsed.label,
      adapterVersion,
      source: parsed.source,
      rows: stagedRows,
    });
    return uploadResponse(batch, false);
  } catch (error) {
    console.error("import-staging-failed", {
      batchId,
      adapterId: parsed.adapterId,
      error: errorName(error),
    });
    const failed = await repositories.imports.failBatch(userId, batchId, {
      code: "processing-failed",
      message: "The file could not be staged for review.",
    });
    return uploadResponse(failed, false);
  }
}

async function stageCreatedMappedBatch(
  userId: string,
  batchId: string,
  upload: FlightImportUpload,
  mapping: GenericCsvMapping,
  repositories: ImportWorkerRepositories,
): Promise<UploadImportResponse> {
  try {
    const parsed = parseMappedGenericCsv(upload.content, mapping);
    const rows = await mapGenericRows(
      userId,
      batchId,
      upload.content,
      parsed,
      repositories.airports,
    );
    const existingCandidates =
      await repositories.flights.findDuplicateCandidates(userId, rows);
    const stagedRows = applyDuplicateCandidates(rows, existingCandidates);
    const batch = await repositories.imports.completeStaging(userId, batchId, {
      adapterId: "generic-csv-v1",
      adapterLabel: parsed.adapter.format,
      adapterVersion: parsed.adapter.version,
      source: "CSV",
      rows: stagedRows,
    });
    return uploadResponse(batch, false);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "processing-failed";
    console.error("import-staging-failed", {
      batchId,
      adapterId: "generic-csv-v1",
      code,
      error: errorName(error),
    });
    const failed = await repositories.imports.failBatch(userId, batchId, {
      code,
      message: "The mapped CSV could not be staged for review.",
    });
    return uploadResponse(failed, false);
  }
}

// Failures are reported through the batch status/error UX; the class name is
// logged so a staging regression is attributable without putting logbook
// contents in the logs.
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function mapParsedRows(
  userId: string,
  batchId: string,
  content: string,
  parsed: Extract<ParsedFlightImport, { status: "parsed" }>,
  airports: AirportRepository,
): Promise<StoredImportRow[]> {
  const rawByRowNumber = new Map(
    parseCsv(content).map((record) => [record.rowNumber, record.cells]),
  );
  if (parsed.adapterId === "foreflight-v1") {
    const defaults = sourceRoleDefault({ adapterId: parsed.adapterId })!;
    const sourceRowKeys = assignSourceRowKeys(
      userId,
      parsed.adapterId,
      parsed.parsed.flights.map((flight) => ({
        rowNumber: flight.sourceRowNumber,
        projection: {
          date: flight.date,
          departureTime: flight.departureTime,
          originIdentifier: flight.originIdentifier,
          destinationIdentifier: flight.destinationIdentifier,
          registration: flight.registration,
          aircraft: flight.aircraftDisplayName,
        },
      })),
    );
    return Promise.all(
      parsed.parsed.flights.map(async (flight) => {
        const origin = await resolveOptional(
          userId,
          flight.originIdentifier,
          airports,
        );
        const destination = await resolveOptional(
          userId,
          flight.destinationIdentifier,
          airports,
        );
        const route = await normalizeFlightRoute({
          routeRaw: flight.routeRaw,
          origin: { identifier: flight.originIdentifier, match: origin, field: "From" },
          destination: {
            identifier: flight.destinationIdentifier,
            match: destination,
            field: "To",
          },
          resolve: (identifier) =>
            airports.resolveIdentifier(userId, identifier),
        });
        const proposedFlight: ProposedImportFlight = {
          date: flight.date,
          departureTime: flight.departureTime,
          originIdentifier: flight.originIdentifier,
          destinationIdentifier: flight.destinationIdentifier,
          origin,
          destination,
          routeNodes: route.nodes,
          ...(route.rejections.length
            ? { routeRejections: route.rejections }
            : {}),
          ...(route.routeRaw ? { routeRaw: route.routeRaw } : {}),
          ...(flight.landings ? { landingCounts: flight.landings } : {}),
          ...defaults,
          aircraft: flight.aircraftDisplayName,
          aircraftType: flight.aircraftType,
          aircraftModel: flight.aircraftModel,
          registration: flight.registration,
          distanceMiles:
            flight.distanceNauticalMiles === undefined
              ? undefined
              : Number((flight.distanceNauticalMiles * 1.150779448).toFixed(2)),
          durationHours: flight.totalTimeHours,
          source: "ForeFlight",
          classificationOrigin: "source-default",
        };
        const sourceRowKey = sourceRowKeys.get(flight.sourceRowNumber);
        return createStoredRow({
          userId,
          batchId,
          rowNumber: flight.sourceRowNumber,
          rawSnapshot: rawByRowNumber.get(flight.sourceRowNumber) ?? null,
          proposedFlight,
          issues: [...flight.issues, ...route.issues],
          ...(sourceRowKey ? { sourceRowKey } : {}),
          provenance: {
            adapterId: parsed.adapterId,
            adapterLabel: parsed.label,
            adapterVersion: parsed.parsed.adapter.version,
            source: "ForeFlight",
            sourceRowNumber: flight.sourceRowNumber,
            // Content-addressed, not the source row ordinal: inserting an
            // unrelated row above this one must not change its identity.
            externalStableId:
              sourceRowKey ??
              `${parsed.parsed.adapter.version}:${flight.sourceRowNumber}`,
            ...(sourceRowKey ? { sourceRowKey } : {}),
          },
        });
      }),
    );
  }

  const sourceRowKeys = assignSourceRowKeys(
    userId,
    parsed.adapterId,
    parsed.parsed.flights.map((flight) => ({
      rowNumber: flight.sourceRowNumber,
      projection: {
        date: flight.date,
        departureTime: flight.departureTime,
        originIdentifier:
          flight.originIcaoIdentifier ?? flight.originIdentifier,
        destinationIdentifier:
          flight.destinationIcaoIdentifier ?? flight.destinationIdentifier,
        flightNumber: flight.flightNumber,
        registration: flight.registration,
        aircraft: flight.aircraftModel,
      },
    })),
  );
  return Promise.all(
    parsed.parsed.flights.map(async (flight) => {
      const defaults = sourceRoleDefault({ adapterId: parsed.adapterId })!;
      const origin = await resolvePreferred(
        userId,
        flight.originIcaoIdentifier,
        flight.originIdentifier,
        airports,
      );
      const destination = await resolvePreferred(
        userId,
        flight.destinationIcaoIdentifier,
        flight.destinationIdentifier,
        airports,
      );
      const proposedFlight: ProposedImportFlight = {
        date: flight.date,
        departureTime: flight.departureTime,
        originIdentifier:
          flight.originIcaoIdentifier ?? flight.originIdentifier,
        destinationIdentifier:
          flight.destinationIcaoIdentifier ?? flight.destinationIdentifier,
        origin,
        destination,
        ...defaults,
        aircraft: flight.aircraftModel,
        aircraftModel: flight.aircraftModel,
        registration: flight.registration,
        flightNumber: flight.flightNumber,
        airline: flight.airline ?? flight.airlineCode,
        durationHours:
          flight.durationMinutes === undefined
            ? undefined
            : Number((flight.durationMinutes / 60).toFixed(3)),
        source: "FlightRadar24",
        classificationOrigin: "source-default",
      };
      const sourceRowKey = sourceRowKeys.get(flight.sourceRowNumber);
      return createStoredRow({
        userId,
        batchId,
        rowNumber: flight.sourceRowNumber,
        rawSnapshot: rawByRowNumber.get(flight.sourceRowNumber) ?? null,
        proposedFlight,
        issues: flight.issues,
        ...(sourceRowKey ? { sourceRowKey } : {}),
        provenance: {
          adapterId: parsed.adapterId,
          adapterLabel: parsed.label,
          adapterVersion: parsed.parsed.adapter.version,
          source: "FlightRadar24",
          sourceRowNumber: flight.sourceRowNumber,
          externalStableId: flight.provenance.idempotencyKey,
          ...(sourceRowKey ? { sourceRowKey } : {}),
        },
      });
    }),
  );
}

async function mapGenericRows(
  userId: string,
  batchId: string,
  content: string,
  parsed: GenericCsvParseResult,
  airports: AirportRepository,
): Promise<StoredImportRow[]> {
  const rawByRowNumber = new Map(
    parseCsv(content, detectCsvDelimiter(content)).map((record) => [
      record.rowNumber,
      record.cells,
    ]),
  );
  const sourceRowKeys = assignSourceRowKeys(
    userId,
    "generic-csv-v1",
    parsed.flights.map((flight) => ({
      rowNumber: flight.sourceRowNumber,
      projection: {
        date: flight.date,
        departureTime: flight.departureTime,
        originIdentifier: flight.originIdentifier,
        destinationIdentifier: flight.destinationIdentifier,
        airportIdentifiers: flight.airportIdentifiers,
        flightNumber: flight.flightNumber,
        registration: flight.registration,
        aircraft: flight.aircraft ?? flight.aircraftModel,
      },
    })),
  );
  return Promise.all(
    parsed.flights.map(async (flight) => {
      const airportIdentifiers =
        flight.airportIdentifiers ??
        [flight.originIdentifier, flight.destinationIdentifier].filter(
          (identifier): identifier is string => Boolean(identifier),
        );
      const airportMatches = await resolveSequence(
        userId,
        airportIdentifiers,
        airports,
      );
      const origin = airportMatches[0];
      const destination = airportMatches.at(-1);
      const routeIssues = airportMatches.flatMap((match, index) =>
        match.status === "resolved"
          ? []
          : [{
              code: "missing-airport" as const,
              field: `route[${index}]`,
              message: `Route stop ${index + 1} (${match.identifier}) could not be resolved`,
              severity: "warning" as const,
            }],
      );
      const proposedFlight: ProposedImportFlight = {
        date: flight.date,
        departureTime: flight.departureTime,
        originIdentifier: flight.originIdentifier,
        destinationIdentifier: flight.destinationIdentifier,
        origin,
        destination,
        airportIdentifiers,
        airportMatches,
        kind: flight.kind,
        role: flight.role,
        aircraft: flight.aircraft,
        aircraftType: flight.aircraftType,
        aircraftModel: flight.aircraftModel,
        registration: flight.registration,
        flightNumber: flight.flightNumber,
        airline: flight.airline,
        durationHours: flight.durationHours,
        distanceMiles: flight.distanceMiles,
        source: "CSV",
        classificationOrigin: sourceRoleDefault({
          adapterId: "generic-csv-v1",
          presetId: parsed.adapter.presetId,
        })
          ? "source-default"
          : "explicit",
      };
      const sourceRowKey = sourceRowKeys.get(flight.sourceRowNumber);
      return createStoredRow({
        userId,
        batchId,
        rowNumber: flight.sourceRowNumber,
        rawSnapshot: rawByRowNumber.get(flight.sourceRowNumber) ?? null,
        proposedFlight,
        issues: [...flight.issues, ...routeIssues],
        ...(sourceRowKey ? { sourceRowKey } : {}),
        provenance: {
          adapterId: "generic-csv-v1",
          adapterLabel: parsed.adapter.format,
          adapterVersion: parsed.adapter.version,
          source: "CSV",
          sourceRowNumber: flight.sourceRowNumber,
          externalStableId: flight.idempotencyKey,
          ...(sourceRowKey ? { sourceRowKey } : {}),
        },
      });
    }),
  );
}

function createStoredRow(input: {
  userId: string;
  batchId: string;
  rowNumber: number;
  rawSnapshot: string[] | null;
  proposedFlight: ProposedImportFlight;
  issues: ImportIssue[];
  sourceRowKey?: string;
  provenance: StoredImportRow["provenance"];
}): StoredImportRow {
  const commitReady = isImportProposalCommitReady(
    input.proposedFlight,
    input.issues,
  );
  const rowFingerprint = commitReady
    ? createRowFingerprint(
        input.userId,
        input.proposedFlight,
        input.sourceRowKey,
      )
    : undefined;
  return {
    id: randomUUID(),
    batchId: input.batchId,
    rowNumber: input.rowNumber,
    rawSnapshot: input.rawSnapshot,
    proposedFlight: input.proposedFlight,
    issues: input.issues,
    validationState: importProposalValidationState(
      input.proposedFlight,
      input.issues,
    ),
    commitReady,
    decision: "pending",
    rowFingerprint,
    ...(commitReady
      ? {
          legacyRowFingerprint: createLegacyRowFingerprint(
            input.userId,
            input.proposedFlight,
          ),
        }
      : {}),
    provenance: input.provenance,
  };
}

async function resolveOptional(
  userId: string,
  identifier: string | undefined,
  airports: AirportRepository,
): Promise<ImportAirportMatch | undefined> {
  return identifier
    ? airports.resolveIdentifier(userId, identifier)
    : undefined;
}

async function resolvePreferred(
  userId: string,
  preferred: string | undefined,
  fallback: string | undefined,
  airports: AirportRepository,
): Promise<ImportAirportMatch | undefined> {
  if (preferred) {
    const resolution = await airports.resolveIdentifier(userId, preferred);
    if (resolution.status !== "not-found") return resolution;
  }
  return resolveOptional(userId, fallback, airports);
}

async function resolveSequence(
  userId: string,
  identifiers: string[],
  airports: AirportRepository,
): Promise<ImportAirportMatch[]> {
  return Promise.all(
    identifiers.map((identifier) =>
      airports.resolveIdentifier(userId, identifier),
    ),
  );
}

function validateUpload(
  userId: string,
  upload: FlightImportUpload,
  maxBytes: number,
): void {
  if (!userId.trim()) throw new Error("A userId is required");
  if (!upload.fileName.toLowerCase().endsWith(".csv")) {
    throw new Error("Only CSV files are supported");
  }
  if (!ACCEPTED_MIME_TYPES.has(upload.mimeType.toLowerCase())) {
    throw new Error("The upload MIME type is not supported");
  }
  if (upload.sizeBytes <= 0 || upload.sizeBytes > maxBytes) {
    throw new Error(`The upload must be between 1 and ${maxBytes} bytes`);
  }
  if (upload.content.includes("\u0000")) {
    throw new Error("Binary files are not supported");
  }
}

function uploadResponse(
  batch: ImportBatchSummary,
  reused: boolean,
): UploadImportResponse {
  const status =
    batch.status === "review" ||
    batch.status === "failed" ||
    batch.status === "committed"
      ? batch.status
      : "processing";
  return { batchId: batch.id, status, reused };
}
