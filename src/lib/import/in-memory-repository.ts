import { randomUUID } from "node:crypto";
import type { Airport, Flight } from "../flight-data";
import type { ExistingFingerprintCandidate } from "./dedupe";
import type {
  CommitAcceptedImportInput,
  CommitAcceptedImportResult,
  CreateManualFlightInput,
  CreateManualFlightResult,
  FlightRepository,
} from "@/lib/db/repositories/flight-repository";
import type { AirportRepository } from "@/lib/db/repositories/airport-repository";
import type {
  CompleteImportStagingInput,
  CreateImportBatchInput,
  ImportRepository,
  PendingObjectCleanup,
  SupersededImportBatch,
} from "@/lib/db/repositories/import-repository";
import {
  IMPORT_CONTRACT_VERSION,
  type AirportSearchResult,
  type ImportAirportMatch,
  type ImportBatchCounts,
  type ImportBatchSummary,
  type ImportDecisionAction,
  type ImportDuplicateResolution,
  type ImportRowsPage,
  type ProposedImportFlight,
  type StoredImportRow,
  type VersionedFingerprint,
} from "./types";
import { createAcceptedDuplicateFingerprint } from "./fingerprint";
import {
  SUPERSEDABLE_IMPORT_BATCH_STATUSES,
  isReusableImportBatchStatus,
} from "./batch-lifecycle";

type BatchRecord = {
  userId: string;
  fileSizeBytes: number;
  fileFingerprint: VersionedFingerprint;
  summary: ImportBatchSummary;
  rows: StoredImportRow[];
  objectCleanupRecordedAt?: string;
};

type FlightRecord = {
  id: string;
  userId: string;
  fingerprint: VersionedFingerprint;
  flight: ProposedImportFlight;
  sources: Array<{ batchId: string; rowId: string }>;
};

export type InMemoryAirportSeed = {
  id: string;
  airport: Airport;
  aliases: string[];
};

export class InMemoryImportRepository
  implements ImportRepository, FlightRepository, AirportRepository
{
  async createManualFlight(
    userId: string,
    input: CreateManualFlightInput,
  ): Promise<CreateManualFlightResult> {
    requireUser(userId);
    const existing = [...this.flights.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.fingerprint.value === input.fingerprint.value,
    );
    if (existing) return { flightId: existing.id, created: false };
    const id = randomUUID();
    this.flights.set(id, {
      id,
      userId,
      fingerprint: clone(input.fingerprint),
      flight: clone(input.proposal),
      sources: [],
    });
    return { flightId: id, created: true };
  }

  private readonly batches = new Map<string, BatchRecord>();
  private readonly flights = new Map<string, FlightRecord>();
  private readonly airports = new Map<string, InMemoryAirportSeed[]>();
  private readonly overrides: Array<{
    userId: string;
    flightId: string;
    rowId: string;
    field: string;
  }> = [];

  constructor(airports: InMemoryAirportSeed[] = []) {
    this.replaceAirportCatalog(airports);
  }

  replaceAirportCatalog(airports: InMemoryAirportSeed[]): void {
    this.airports.clear();
    for (const seed of airports) {
      for (const alias of new Set([seed.airport.code, ...seed.aliases])) {
        const key = normalize(alias);
        const matches = this.airports.get(key) ?? [];
        matches.push(seed);
        this.airports.set(key, matches);
      }
    }
  }

  async resolveIdentifier(
    userId: string,
    identifier: string,
  ): Promise<ImportAirportMatch> {
    requireUser(userId);
    const normalized = normalize(identifier);
    const matches = this.airports.get(normalized) ?? [];
    if (matches.length === 0) {
      return { status: "not-found", identifier: normalized };
    }

    if (matches.length > 1) {
      return {
        status: "ambiguous",
        identifier: normalized,
        candidates: matches.map(({ id, airport }) => ({
          airportId: id,
          code: airport.code,
          name: airport.name,
        })),
      };
    }

    const [match] = matches;
    return {
      status: "resolved",
      identifier: normalized,
      airportId: match.id,
      airport: clone(match.airport),
    };
  }

  async findById(
    userId: string,
    airportId: string,
  ): Promise<ImportAirportMatch | null> {
    requireUser(userId);
    const match = [...this.airports.values()]
      .flat()
      .find((candidate) => candidate.id === airportId);
    return match
      ? {
          status: "resolved",
          identifier: match.airport.code,
          airportId: match.id,
          airport: clone(match.airport),
        }
      : null;
  }

  async search(
    userId: string,
    query: string,
    limit: number,
  ): Promise<AirportSearchResult[]> {
    requireUser(userId);
    const normalized = normalize(query);
    const unique = new Map<string, InMemoryAirportSeed>();
    for (const matches of this.airports.values()) {
      for (const match of matches) unique.set(match.id, match);
    }
    return [...unique.values()]
      .filter(({ airport, aliases }) =>
        [airport.code, airport.name, airport.city, airport.country, ...aliases]
          .join(" ")
          .toUpperCase()
          .includes(normalized),
      )
      .sort((left, right) =>
        left.airport.code.localeCompare(right.airport.code),
      )
      .slice(0, limit)
      .map(({ id, airport }) => ({
        airportId: id,
        code: airport.code,
        name: airport.name,
        city: airport.city,
        country: airport.country,
      }));
  }

  async findBatchByFileFingerprint(
    userId: string,
    fingerprint: VersionedFingerprint,
  ): Promise<ImportBatchSummary | null> {
    requireUser(userId);
    const record = [...this.batches.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.fileFingerprint.version === fingerprint.version &&
        candidate.fileFingerprint.value === fingerprint.value &&
        isReusableImportBatchStatus(candidate.summary.status),
    );
    return record ? clone(record.summary) : null;
  }

  async createBatch(
    userId: string,
    input: CreateImportBatchInput,
  ): Promise<ImportBatchSummary> {
    requireUser(userId);
    await this.supersedeUnreusableBatches(userId, input.fileFingerprint);
    const existing = [...this.batches.values()].find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.fileFingerprint.version === input.fileFingerprint.version &&
        candidate.fileFingerprint.value === input.fileFingerprint.value &&
        isReusableImportBatchStatus(candidate.summary.status),
    );
    if (existing) return clone(existing.summary);
    const now = new Date().toISOString();
    const summary: ImportBatchSummary = {
      contractVersion: IMPORT_CONTRACT_VERSION,
      id: input.id,
      fileName: input.fileName,
      status: input.status,
      counts: emptyCounts(),
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(input.id, {
      userId,
      fileSizeBytes: input.fileSizeBytes,
      fileFingerprint: clone(input.fileFingerprint),
      summary,
      rows: [],
    });
    return clone(summary);
  }

  async completeStaging(
    userId: string,
    batchId: string,
    input: CompleteImportStagingInput,
  ): Promise<ImportBatchSummary> {
    const record = this.requireBatch(userId, batchId);
    if (record.summary.status !== "processing") {
      throw new Error("Import batch is not processing");
    }
    record.rows = clone(input.rows);
    record.summary = {
      ...record.summary,
      adapterId: input.adapterId,
      adapterLabel: input.adapterLabel,
      adapterVersion: input.adapterVersion,
      source: input.source,
      status: "review",
      counts: countsFor(record.rows),
      updatedAt: new Date().toISOString(),
    };
    return clone(record.summary);
  }

  async failBatch(
    userId: string,
    batchId: string,
    error: { code: string; message: string },
  ): Promise<ImportBatchSummary> {
    const record = this.requireBatch(userId, batchId);
    record.summary = {
      ...record.summary,
      status: "failed",
      error: clone(error),
      updatedAt: new Date().toISOString(),
    };
    return clone(record.summary);
  }

  // Mirrors DrizzleImportRepository: a failed or cancelled attempt stops
  // owning the file fingerprint so the same bytes can be staged again. This
  // repository has no private object storage, so nothing is ever pending.
  async supersedeUnreusableBatches(
    userId: string,
    fingerprint: VersionedFingerprint,
    exceptBatchId?: string,
  ): Promise<SupersededImportBatch[]> {
    requireUser(userId);
    const superseded: SupersededImportBatch[] = [];
    for (const [batchId, record] of this.batches.entries()) {
      if (
        batchId === exceptBatchId ||
        record.userId !== userId ||
        record.fileFingerprint.version !== fingerprint.version ||
        record.fileFingerprint.value !== fingerprint.value ||
        !(
          SUPERSEDABLE_IMPORT_BATCH_STATUSES as readonly string[]
        ).includes(record.summary.status)
      ) {
        continue;
      }
      scrubRawSnapshots(record.rows);
      record.summary = {
        ...record.summary,
        status: "expired",
        updatedAt: new Date().toISOString(),
      };
      superseded.push({ batchId, pendingObjectKeys: [] });
    }
    return superseded;
  }

  // Batches staged here never own a private object, so a sweep has nothing to
  // delete. The cleanup stamp is still recorded so callers that mirror the
  // production flow observe the same state transitions.
  async listBatchesPendingObjectCleanup(
    userId: string,
  ): Promise<PendingObjectCleanup[]> {
    requireUser(userId);
    return [];
  }

  async recordBatchObjectCleanup(
    userId: string,
    batchId: string,
  ): Promise<void> {
    const record = this.requireBatch(userId, batchId);
    record.objectCleanupRecordedAt = new Date().toISOString();
  }

  /** Test seam: when the cleanup stamp was recorded, if at all. */
  objectCleanupRecordedAt(userId: string, batchId: string): string | undefined {
    return this.requireBatch(userId, batchId).objectCleanupRecordedAt;
  }

  async expireBatchAndScrub(userId: string, batchId: string): Promise<void> {
    const record = this.requireBatch(userId, batchId);
    scrubRawSnapshots(record.rows);
    record.summary = {
      ...record.summary,
      status: "expired",
      updatedAt: new Date().toISOString(),
    };
  }

  async scrubBatchRawSnapshots(userId: string, batchId: string): Promise<void> {
    scrubRawSnapshots(this.requireBatch(userId, batchId).rows);
  }

  async listBatches(userId: string): Promise<ImportBatchSummary[]> {
    requireUser(userId);
    return [...this.batches.values()]
      .filter((record) => record.userId === userId)
      .map((record) => clone(record.summary))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getBatch(
    userId: string,
    batchId: string,
  ): Promise<ImportBatchSummary | null> {
    requireUser(userId);
    const record = this.batches.get(batchId);
    return record?.userId === userId ? clone(record.summary) : null;
  }

  async listRows(
    userId: string,
    batchId: string,
    page: number,
    pageSize: number,
  ): Promise<ImportRowsPage | null> {
    requireUser(userId);
    const record = this.batches.get(batchId);
    if (!record || record.userId !== userId) return null;
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    const totalPages = Math.max(1, Math.ceil(record.rows.length / safePageSize));
    const safePage = Math.min(totalPages, Math.max(1, Math.trunc(page)));
    const start = (safePage - 1) * safePageSize;
    return {
      page: safePage,
      pageSize: safePageSize,
      totalRows: record.rows.length,
      totalPages,
      rows: clone(record.rows.slice(start, start + safePageSize)),
    };
  }

  async getRowsForCommit(
    userId: string,
    batchId: string,
  ): Promise<StoredImportRow[] | null> {
    requireUser(userId);
    const record = this.batches.get(batchId);
    return record?.userId === userId ? clone(record.rows) : null;
  }

  async replaceReviewRows(
    userId: string,
    batchId: string,
    rows: StoredImportRow[],
    expectedBatchUpdatedAt?: string,
  ): Promise<ImportBatchSummary> {
    const record = this.requireBatch(userId, batchId);
    if (record.summary.status !== "review") {
      throw new Error("Import batch is not in review");
    }
    if (
      expectedBatchUpdatedAt &&
      record.summary.updatedAt !== expectedBatchUpdatedAt
    ) {
      throw new Error("Import batch changed during reconciliation");
    }
    record.rows = clone(rows);
    record.summary = {
      ...record.summary,
      counts: countsFor(record.rows, record.summary.counts),
      updatedAt: new Date().toISOString(),
    };
    return clone(record.summary);
  }

  async applyDecisions(
    userId: string,
    batchId: string,
    decisions: Array<{
      rowId: string;
      action: ImportDecisionAction;
      duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">;
    }>,
  ): Promise<ImportBatchSummary> {
    const record = this.requireBatch(userId, batchId);
    if (record.summary.status !== "review") {
      throw new Error("Import batch is not in review");
    }
    const byId = new Map(record.rows.map((row) => [row.id, row]));
    const decidedAt = new Date().toISOString();
    for (const decision of decisions) {
      const row = byId.get(decision.rowId);
      if (!row) throw new Error("Import row not found");
      if (
        row.duplicateCandidate &&
        decision.action === "accepted" &&
        !decision.duplicateResolution
      ) {
        throw new Error("Duplicate resolution is required");
      }
      if (!row.duplicateCandidate && decision.duplicateResolution) {
        throw new Error("A non-duplicate row cannot have a duplicate resolution");
      }
      row.decision = decision.action;
      if (row.duplicateCandidate && decision.duplicateResolution) {
        row.duplicateCandidate.resolution = decision.duplicateResolution;
      }
      row.decidedAt = decidedAt;
    }
    record.summary = {
      ...record.summary,
      counts: countsFor(record.rows, record.summary.counts),
      updatedAt: decidedAt,
    };
    return clone(record.summary);
  }

  async findDuplicateCandidates(
    userId: string,
    rows: StoredImportRow[],
  ): Promise<ExistingFingerprintCandidate[]> {
    requireUser(userId);
    const dates = new Set(
      rows.flatMap((row) =>
        row.proposedFlight.date ? [row.proposedFlight.date.slice(0, 10)] : [],
      ),
    );
    return [...this.flights.values()]
      .filter(
        (flight) =>
          flight.userId === userId &&
          Boolean(
            flight.flight.date &&
              dates.has(flight.flight.date.slice(0, 10)),
          ),
      )
      .map((flight) => ({
        flightId: flight.id,
        fingerprint: clone(flight.fingerprint),
        flight: clone(flight.flight),
      }));
  }

  async listFlights(userId: string): Promise<Flight[]> {
    requireUser(userId);
    return [...this.flights.values()]
      .filter((flight) => flight.userId === userId)
      .map(({ id, flight }) => {
        const airportSequence =
          flight.airportMatches
            ?.filter(
              (
                match,
              ): match is Extract<ImportAirportMatch, { status: "resolved" }> =>
                match.status === "resolved",
            )
            .map((match) => clone(match.airport)) ?? [];
        return {
        id,
        date: flight.date!,
        origin:
          flight.origin?.status === "resolved"
            ? clone(flight.origin.airport)
            : missingAirport(flight.originIdentifier),
        destination:
          flight.destination?.status === "resolved"
            ? clone(flight.destination.airport)
            : missingAirport(flight.destinationIdentifier),
        ...(airportSequence.length >= 2 ? { airportSequence } : {}),
        kind: flight.kind,
        role: flight.role,
        aircraft:
          flight.aircraft ??
          flight.aircraftModel ??
          flight.aircraftType ??
          "Aircraft not specified",
        aircraftType: flight.aircraftType,
        aircraftModel: flight.aircraftModel,
        registration: flight.registration,
        flightNumber: flight.flightNumber,
        airline: flight.airline,
        departureTime: flight.departureTime,
        distanceMiles: flight.distanceMiles ?? 0,
        durationHours: flight.durationHours,
        source: flight.source,
        };
      })
      .sort((left, right) => right.date.localeCompare(left.date));
  }

  async commitAcceptedImport(
    userId: string,
    input: CommitAcceptedImportInput,
  ): Promise<CommitAcceptedImportResult> {
    const record = this.requireBatch(userId, input.batch.id);
    if (record.summary.status === "committed") {
      return {
        batchId: input.batch.id,
        status: "committed",
        acceptedRows: record.summary.counts.acceptedRows,
        createdFlights: record.summary.counts.importedRows ?? 0,
        attachedSources: record.summary.counts.attachedSources,
      };
    }
    if (record.summary.status !== "review") {
      throw new Error("Import batch is not in review");
    }

    const accepted = input.rows.filter((row) => row.decision === "accepted");
    let createdFlights = 0;
    let attachedSources = 0;
    const resolvedFlightByRow = new Map<string, FlightRecord>();
    for (const row of accepted) {
      if (!row.commitReady || !row.rowFingerprint) {
        throw new Error("An accepted row is not commit-ready");
      }
      if (row.duplicateCandidate?.resolution === "pending") {
        throw new Error("Duplicate resolution is required");
      }
      let existing: FlightRecord | undefined;
      if (row.duplicateCandidate?.resolution === "skip_as_duplicate") {
        existing =
          row.duplicateCandidate.scope === "existing-flight"
            ? this.flights.get(row.duplicateCandidate.candidateId)
            : resolvedFlightByRow.get(row.duplicateCandidate.candidateId);
        if (!existing || existing.userId !== userId) {
          throw new Error("The selected duplicate target is unavailable");
        }
      } else {
        const fingerprint =
          row.duplicateCandidate?.resolution === "accept_new"
            ? createAcceptedDuplicateFingerprint(
                userId,
                row.id,
                row.rowFingerprint,
              )
            : row.rowFingerprint;
        existing = [...this.flights.values()].find(
          (flight) =>
            flight.userId === userId &&
            flight.fingerprint.value === fingerprint.value,
        );
        if (!existing) {
          const id = randomUUID();
          existing = {
            id,
            userId,
            fingerprint: clone(fingerprint),
            flight: clone(row.proposedFlight),
            sources: [{ batchId: input.batch.id, rowId: row.id }],
          };
          this.flights.set(id, existing);
          for (const correction of row.corrections ?? []) {
            this.overrides.push({
              userId,
              flightId: id,
              rowId: row.id,
              field: correction.field,
            });
          }
          createdFlights += 1;
        }
      }
      if (existing) {
        if (
          !existing.sources.some(
            (source) =>
              source.batchId === input.batch.id && source.rowId === row.id,
          )
        ) {
          existing.sources.push({ batchId: input.batch.id, rowId: row.id });
          attachedSources += 1;
        }
      }
      resolvedFlightByRow.set(row.id, existing);
    }

    const now = new Date().toISOString();
    scrubDecidedRawSnapshots(record.rows);
    const status = record.rows.some((row) => row.decision === "pending")
      ? "review"
      : "committed";
    const linkedFlights = [...this.flights.values()].filter(
      (flight) =>
        flight.userId === userId &&
        flight.sources.some((source) => source.batchId === input.batch.id),
    );
    const linkedSources = linkedFlights.flatMap((flight) =>
      flight.sources.filter((source) => source.batchId === input.batch.id),
    );
    record.summary = {
      ...record.summary,
      status,
      counts: {
        ...countsFor(record.rows),
        importedRows:
          (record.summary.counts.importedRows ?? 0) + createdFlights,
        committedFlights: linkedFlights.length,
        attachedSources: linkedSources.length,
      },
      updatedAt: now,
    };
    return {
      batchId: input.batch.id,
      status,
      acceptedRows: accepted.length,
      createdFlights,
      attachedSources,
    };
  }

  listCorrectionOverrides(userId: string): Array<{
    flightId: string;
    rowId: string;
    field: string;
  }> {
    return this.overrides
      .filter((override) => override.userId === userId)
      .map(({ flightId, rowId, field }) => ({ flightId, rowId, field }));
  }

  private requireBatch(userId: string, batchId: string): BatchRecord {
    requireUser(userId);
    const record = this.batches.get(batchId);
    if (!record || record.userId !== userId) {
      throw new Error("Import batch not found");
    }
    return record;
  }
}

function emptyCounts(): ImportBatchCounts {
  return {
    totalRows: 0,
    parsedRows: 0,
    readyRows: 0,
    acceptedRows: 0,
    skippedRows: 0,
    pendingRows: 0,
    unresolvedDuplicateRows: 0,
    importedRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    reviewRequiredRows: 0,
    committedFlights: 0,
    attachedSources: 0,
  };
}

function countsFor(
  rows: StoredImportRow[],
  previous: ImportBatchCounts = emptyCounts(),
): ImportBatchCounts {
  return {
    totalRows: rows.length,
    parsedRows: rows.length,
    readyRows: rows.filter((row) => row.commitReady).length,
    acceptedRows: rows.filter((row) => row.decision === "accepted").length,
    skippedRows: rows.filter((row) => row.decision === "skipped").length,
    pendingRows: rows.filter((row) => row.decision === "pending").length,
    unresolvedDuplicateRows: rows.filter(
      (row) =>
        row.duplicateCandidate?.resolution === "pending" &&
        row.decision !== "skipped",
    ).length,
    importedRows: previous.importedRows ?? 0,
    duplicateRows: rows.filter(
      (row) =>
        row.decision === "skipped" &&
        row.duplicateCandidate?.resolution === "skip_as_duplicate",
    ).length,
    invalidRows: rows.filter((row) => !row.commitReady).length,
    reviewRequiredRows: rows.filter((row) => row.decision === "pending").length,
    committedFlights: previous.committedFlights,
    attachedSources: previous.attachedSources,
  };
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function missingAirport(identifier: string | undefined): Airport {
  return {
    code: identifier ?? "UNKNOWN",
    name: identifier ?? "Unknown airport",
    city: "",
    country: "",
    lat: 0,
    lon: 0,
    facility: "general-aviation",
  };
}

function requireUser(userId: string): void {
  if (!userId.trim()) throw new Error("A userId is required");
}

function scrubRawSnapshots(rows: StoredImportRow[]): void {
  for (const row of rows) row.rawSnapshot = null;
}

function scrubDecidedRawSnapshots(rows: StoredImportRow[]): void {
  for (const row of rows) {
    if (row.decision !== "pending") row.rawSnapshot = null;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
