import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import type { Airport, Flight, FlightSource } from "@/lib/flight-data";
import { preferredAirportCode } from "@/lib/airport-preferred-code";
import type {
  ExistingFingerprintCandidate,
} from "@/lib/import/dedupe";
import { createAcceptedDuplicateFingerprint } from "@/lib/import/fingerprint";
import {
  NON_REUSABLE_IMPORT_BATCH_STATUSES,
  SUPERSEDABLE_IMPORT_BATCH_STATUSES,
} from "@/lib/import/batch-lifecycle";
import {
  airportSearchPhoneticKeys,
  selectBestAirportAliasMatches,
} from "@/lib/import/airport-resolution";
import {
  IMPORT_CONTRACT_VERSION,
  type AirportSearchResult,
  type ImportAirportMatch,
  type ImportBatchCounts,
  type ImportBatchStatus,
  type ImportBatchSummary,
  type ImportDecisionAction,
  type ImportDuplicateResolution,
  type ImportRowsPage,
  type ProposedImportFlight,
  type StoredImportRow,
  type VersionedFingerprint,
} from "@/lib/import/types";
import { withUserDb, type DatabaseTransaction } from "../index";
import {
  airportAliases,
  airports,
  duplicateCandidates,
  flightOverrides,
  flightSources,
  flightStops,
  flights as flightTable,
  importBatches,
  importRows,
} from "../schema";
import type { AirportRepository } from "./airport-repository";
import type {
  CommitAcceptedImportInput,
  CommitAcceptedImportResult,
  CreateManualFlightInput,
  CreateManualFlightResult,
  FlightRepository,
} from "./flight-repository";
import type {
  CompleteImportStagingInput,
  CreateImportBatchInput,
  ImportRepository,
  PendingObjectCleanup,
  SupersededImportBatch,
} from "./import-repository";
import { MAX_OBJECT_CLEANUP_BATCH } from "./import-repository";

export class DrizzleImportRepository
  implements ImportRepository, FlightRepository, AirportRepository
{
  constructor(
    private readonly runWithUserDb: typeof withUserDb = withUserDb,
  ) {}

  async createManualFlight(
    userId: string,
    input: CreateManualFlightInput,
  ): Promise<CreateManualFlightResult> {
    const airportIds = resolvedAirportIds(input.proposal);
    const originAirportId = airportIds[0];
    const destinationAirportId = airportIds.at(-1);
    const date = input.proposal.date;
    if (!date || !originAirportId || !destinationAirportId) {
      throw new Error("A manual flight requires a date and resolved airports");
    }
    return this.runWithUserDb(userId, async (tx) => {
      const [created] = await tx
        .insert(flightTable)
        .values({
          userId,
          fingerprint: input.fingerprint.value,
          date,
          originAirportId,
          destinationAirportId,
          kind: input.proposal.kind,
          role: input.proposal.role,
          roleOrigin: "explicit",
          sourceType: "Manual",
          aircraft:
            input.proposal.aircraft ?? input.proposal.aircraftModel,
          aircraftType: input.proposal.aircraftType,
          registration: input.proposal.registration,
          flightNumber: input.proposal.flightNumber,
          airline: input.proposal.airline,
          departureTime: input.proposal.departureTime,
          distanceMiles: input.proposal.distanceMiles,
          durationHours: input.proposal.durationHours,
        })
        .onConflictDoNothing()
        .returning({ id: flightTable.id });
      if (created) {
        await insertFlightStops(tx, userId, created.id, airportIds);
        return { flightId: created.id, created: true };
      }
      const [existing] = await tx
        .select({ id: flightTable.id })
        .from(flightTable)
        .where(
          and(
            eq(flightTable.userId, userId),
            eq(flightTable.fingerprint, input.fingerprint.value),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Manual flight could not be resolved");
      return { flightId: existing.id, created: false };
    });
  }

  async listFlights(userId: string): Promise<Flight[]> {
    return this.runWithUserDb(userId, async (tx) => {
      const storedFlights = await tx
        .select()
        .from(flightTable)
        .where(eq(flightTable.userId, userId))
        .orderBy(desc(flightTable.date), asc(flightTable.id));
      if (storedFlights.length === 0) return [];

      const airportIds = [
        ...new Set(
          storedFlights.flatMap((flight) => [
            flight.originAirportId,
            flight.destinationAirportId,
          ]),
        ),
      ];
      const storedStops = await tx
        .select()
        .from(flightStops)
        .where(
          and(
            eq(flightStops.userId, userId),
            inArray(
              flightStops.flightId,
              storedFlights.map(({ id }) => id),
            ),
          ),
        )
        .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder));
      for (const stop of storedStops) airportIds.push(stop.airportId);
      const airportRows = await tx
        .select()
        .from(airports)
        .where(inArray(airports.id, airportIds));
      const airportById = new Map(
        airportRows.map((airport) => [airport.id, toAirport(airport)]),
      );
      const stopsByFlight = new Map<string, typeof storedStops>();
      for (const stop of storedStops) {
        const stops = stopsByFlight.get(stop.flightId) ?? [];
        stops.push(stop);
        stopsByFlight.set(stop.flightId, stops);
      }
      return storedFlights.map((flight) => {
        const origin = airportById.get(flight.originAirportId);
        const destination = airportById.get(flight.destinationAirportId);
        if (!origin || !destination) {
          throw new Error("A committed flight references a missing airport");
        }
        const airportSequence = (
          stopsByFlight.get(flight.id)?.map((stop) =>
            airportById.get(stop.airportId),
          ) ?? [origin, destination]
        );
        if (
          airportSequence.length < 2 ||
          airportSequence.some((airport) => !airport)
        ) {
          throw new Error("A committed flight route references a missing airport");
        }
        const resolvedSequence = airportSequence as Airport[];
        return {
          id: flight.id,
          date: flight.date,
          origin,
          destination,
          airportSequence: resolvedSequence,
          kind: flight.kind as Flight["kind"],
          role: flight.role as Flight["role"],
          aircraft:
            flight.aircraft ??
            flight.aircraftType ??
            "Aircraft not specified",
          aircraftType: flight.aircraftType ?? undefined,
          registration: flight.registration ?? undefined,
          flightNumber: flight.flightNumber ?? undefined,
          airline: flight.airline ?? undefined,
          departureTime: flight.departureTime ?? undefined,
          distanceMiles:
            flight.distanceMiles ?? routeDistanceMiles(resolvedSequence),
          durationHours: flight.durationHours ?? undefined,
          source: flightSource(flight.sourceType),
        };
      });
    });
  }

  async resolveIdentifier(
    userId: string,
    identifier: string,
  ): Promise<ImportAirportMatch> {
    const normalized = identifier.trim().toUpperCase();
    return this.runWithUserDb(userId, async (tx) => {
      const aliasMatches = await tx
        .select({
          ...getTableColumns(airports),
          aliasPriority: airportAliases.priority,
        })
        .from(airportAliases)
        .innerJoin(airports, eq(airportAliases.airportId, airports.id))
        .where(eq(airportAliases.code, normalized))
        .orderBy(asc(airportAliases.priority), asc(airports.id));
      const matches = selectBestAirportAliasMatches(aliasMatches);
      if (matches.length === 0) {
        return { status: "not-found", identifier: normalized };
      }

      if (matches.length > 1) {
        return {
          status: "ambiguous",
          identifier: normalized,
          candidates: matches.map((match) => ({
            airportId: match.id,
            code: airportCode(match),
            name: match.name,
          })),
        };
      }
      const [match] = matches;
      return {
        status: "resolved",
        identifier: normalized,
        airportId: match.id,
        airport: toAirport(match),
      };
    });
  }

  async findById(
    userId: string,
    airportId: string,
  ): Promise<ImportAirportMatch | null> {
    return this.runWithUserDb(userId, async (tx) => {
      const [match] = await tx
        .select()
        .from(airports)
        .where(eq(airports.id, airportId))
        .limit(1);
      return match
        ? {
            status: "resolved",
            identifier: airportCode(match),
            airportId: match.id,
            airport: toAirport(match),
          }
        : null;
    });
  }

  async search(
    userId: string,
    query: string,
    limit: number,
  ): Promise<AirportSearchResult[]> {
    const normalized = query.trim();
    return this.runWithUserDb(userId, async (tx) => {
      const pattern = `%${normalized.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const phoneticConditions = airportSearchPhoneticKeys(normalized).map(
        (key) => ilike(airports.searchKey, `%${key}%`),
      );
      const matches = await tx
        .select()
        .from(airports)
        .where(
          or(
            ilike(airports.icao, pattern),
            ilike(airports.iata, pattern),
            ilike(airports.localCode, pattern),
            ilike(airports.name, pattern),
            ilike(airports.city, pattern),
            ilike(airports.searchKeywords, pattern),
            inArray(
              airports.id,
              tx
                .select({ airportId: airportAliases.airportId })
                .from(airportAliases)
                .where(ilike(airportAliases.code, pattern)),
            ),
            ...phoneticConditions,
          ),
        )
        .orderBy(asc(airports.iata), asc(airports.icao), asc(airports.name))
        .limit(limit);
      return matches.map((match) => ({
        airportId: match.id,
        code: airportCode(match),
        icao: match.icao ?? undefined,
        iata: match.iata ?? undefined,
        localCode: match.localCode ?? undefined,
        name: match.name,
        city: match.city ?? undefined,
        country: match.country,
      }));
    });
  }

  async findBatchByFileFingerprint(
    userId: string,
    fingerprint: VersionedFingerprint,
  ): Promise<ImportBatchSummary | null> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.fileSha256, fingerprint.value),
            notInArray(importBatches.status, [
              ...NON_REUSABLE_IMPORT_BATCH_STATUSES,
            ]),
          ),
        )
        .limit(1);
      return batch ? summarize(tx, userId, batch) : null;
    });
  }

  // Frees the (user_id, file_sha256) uniqueness slot held by batches that can
  // no longer be reused, so the same bytes can be staged again after a failed
  // attempt. The superseded rows keep their object keys and a null
  // originalDeletedAt, and their retention window is closed immediately, so a
  // failed or skipped delete is still found by listBatchesPendingObjectCleanup
  // instead of orphaning a private upload.
  async supersedeUnreusableBatches(
    userId: string,
    fingerprint: VersionedFingerprint,
    exceptBatchId?: string,
  ): Promise<SupersededImportBatch[]> {
    return this.runWithUserDb(userId, async (tx) => {
      const stale = await tx
        .select({
          id: importBatches.id,
          originalObjectKey: importBatches.originalObjectKey,
          quarantineObjectKey: importBatches.quarantineObjectKey,
          originalDeletedAt: importBatches.originalDeletedAt,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.fileSha256, fingerprint.value),
            inArray(importBatches.status, [
              ...SUPERSEDABLE_IMPORT_BATCH_STATUSES,
            ]),
            ...(exceptBatchId ? [ne(importBatches.id, exceptBatchId)] : []),
          ),
        );
      const now = new Date();
      for (const batch of stale) {
        await scrubRawSnapshots(tx, userId, batch.id, now);
        await tx
          .update(importBatches)
          .set({ status: "expired", expiresAt: now, updatedAt: now })
          .where(
            and(
              eq(importBatches.id, batch.id),
              eq(importBatches.userId, userId),
            ),
          );
      }
      return stale.map((batch) => ({
        batchId: batch.id,
        pendingObjectKeys: batch.originalDeletedAt
          ? []
          : objectKeysFor(batch),
      }));
    });
  }

  // Retention sweeps ask for the batches that still owe an object deletion:
  // anything past its window that has not recorded a successful cleanup.
  // Capped and ordered oldest first so an account that predates cleanup
  // tracking drains over several sweeps instead of stalling one request.
  async listBatchesPendingObjectCleanup(
    userId: string,
  ): Promise<PendingObjectCleanup[]> {
    return this.runWithUserDb(userId, async (tx) => {
      const pending = await tx
        .select({
          id: importBatches.id,
          status: importBatches.status,
          originalObjectKey: importBatches.originalObjectKey,
          quarantineObjectKey: importBatches.quarantineObjectKey,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            lte(importBatches.expiresAt, new Date()),
            isNull(importBatches.originalDeletedAt),
          ),
        )
        .orderBy(asc(importBatches.expiresAt), asc(importBatches.id))
        .limit(MAX_OBJECT_CLEANUP_BATCH);
      return pending.map((batch) => ({
        batchId: batch.id,
        status: batch.status,
        objectKeys: objectKeysFor(batch),
      }));
    });
  }

  // Only ever called after every object for the batch is confirmed gone (or
  // has been handed to a live batch); a failed delete leaves the stamp null so
  // the next sweep retries it.
  async recordBatchObjectCleanup(
    userId: string,
    batchId: string,
  ): Promise<void> {
    return this.runWithUserDb(userId, async (tx) => {
      const now = new Date();
      await tx
        .update(importBatches)
        .set({ originalDeletedAt: now, updatedAt: now })
        .where(
          and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)),
        );
    });
  }

  async createBatch(
    userId: string,
    input: CreateImportBatchInput,
  ): Promise<ImportBatchSummary> {
    // Retries of the same file are only possible once the failed attempt
    // stops holding the uniqueness slot. Object cleanup is tracked on the
    // superseded rows themselves, so callers that own storage can delete the
    // returned keys immediately while repository-only callers still leave the
    // work discoverable for the retention sweep.
    await this.supersedeUnreusableBatches(userId, input.fileFingerprint);
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .insert(importBatches)
        .values({
          id: input.id,
          userId,
          adapterId: "pending-detection",
          adapterVersion: 0,
          status: "processing",
          originalObjectKey: input.originalObjectKey ?? "",
          originalFileName: input.fileName,
          fileSha256: input.fileFingerprint.value,
          fileSizeBytes: input.fileSizeBytes,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .onConflictDoNothing()
        .returning();
      if (batch) return summarize(tx, userId, batch);
      const [existing] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.fileSha256, input.fileFingerprint.value),
            notInArray(importBatches.status, [
              ...NON_REUSABLE_IMPORT_BATCH_STATUSES,
            ]),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error("Import batch could not be created or reused");
      }
      return summarize(tx, userId, existing);
    });
  }

  async completeStaging(
    userId: string,
    batchId: string,
    input: CompleteImportStagingInput,
  ): Promise<ImportBatchSummary> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .update(importBatches)
        .set({
          adapterId: input.adapterId,
          adapterVersion: input.adapterVersion,
          status: "review",
          totalRows: input.rows.length,
          parsedRows: input.rows.length,
          failureCode: null,
          failureMessage: null,
          nextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .returning();
      if (!batch) throw new Error("Import batch not found");

      if (input.rows.length > 0) {
        await tx.insert(importRows).values(
          input.rows.map((row) => ({
            id: row.id,
            userId,
            batchId,
            rowNumber: row.rowNumber,
            rawSnapshot: row.rawSnapshot,
            parsed: persistedRow(row),
            validationState: databaseValidationState(row.validationState),
            matchConfidence: row.duplicateCandidate?.score,
            proposedFlight: row.proposedFlight,
            userDecision: row.decision,
            decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
          })),
        );
        await persistDuplicateCandidates(tx, userId, batchId, input.rows);
      }
      return summarize(tx, userId, batch);
    });
  }

  async failBatch(
    userId: string,
    batchId: string,
    error: { code: string; message: string },
  ): Promise<ImportBatchSummary> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .update(importBatches)
        .set({
          status: "failed",
          failureCode: error.code,
          failureMessage: error.message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .returning();
      if (!batch) throw new Error("Import batch not found");
      return summarize(tx, userId, batch);
    });
  }

  async expireBatchAndScrub(userId: string, batchId: string): Promise<void> {
    return this.runWithUserDb(userId, async (tx) => {
      const now = new Date();
      await scrubRawSnapshots(tx, userId, batchId, now);
      const [batch] = await tx
        .update(importBatches)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .returning({ id: importBatches.id });
      if (!batch) throw new Error("Import batch not found");
    });
  }

  async scrubBatchRawSnapshots(userId: string, batchId: string): Promise<void> {
    return this.runWithUserDb(userId, (tx) =>
      scrubRawSnapshots(tx, userId, batchId, new Date()),
    );
  }

  async listBatches(userId: string): Promise<ImportBatchSummary[]> {
    return this.runWithUserDb(userId, async (tx) => {
      const batches = await tx
        .select()
        .from(importBatches)
        .where(eq(importBatches.userId, userId))
        .orderBy(desc(importBatches.createdAt));
      return Promise.all(batches.map((batch) => summarize(tx, userId, batch)));
    });
  }

  async getBatch(
    userId: string,
    batchId: string,
  ): Promise<ImportBatchSummary | null> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1);
      return batch ? summarize(tx, userId, batch) : null;
    });
  }

  async listRows(
    userId: string,
    batchId: string,
    page: number,
    pageSize: number,
  ): Promise<ImportRowsPage | null> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select({ id: importBatches.id })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1);
      if (!batch) return null;

      const allRows = await tx
        .select()
        .from(importRows)
        .where(
          and(eq(importRows.userId, userId), eq(importRows.batchId, batchId)),
        )
        .orderBy(importRows.rowNumber);
      const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
      const totalPages = Math.max(1, Math.ceil(allRows.length / safePageSize));
      const safePage = Math.min(totalPages, Math.max(1, Math.trunc(page)));
      const start = (safePage - 1) * safePageSize;
      return {
        page: safePage,
        pageSize: safePageSize,
        totalRows: allRows.length,
        totalPages,
        rows: allRows
          .slice(start, start + safePageSize)
          .map(restoreRow),
      };
    });
  }

  async getRowsForCommit(
    userId: string,
    batchId: string,
  ): Promise<StoredImportRow[] | null> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select({ id: importBatches.id })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1);
      if (!batch) return null;
      const rows = await tx
        .select()
        .from(importRows)
        .where(
          and(eq(importRows.userId, userId), eq(importRows.batchId, batchId)),
        )
        .orderBy(importRows.rowNumber);
      return rows.map(restoreRow);
    });
  }

  async replaceReviewRows(
    userId: string,
    batchId: string,
    rows: StoredImportRow[],
    expectedBatchUpdatedAt?: string,
  ): Promise<ImportBatchSummary> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!batch) throw new Error("Import batch not found");
      if (batch.status !== "review") {
        throw new Error("Import batch is not in review");
      }
      if (
        expectedBatchUpdatedAt &&
        batch.updatedAt.toISOString() !== expectedBatchUpdatedAt
      ) {
        throw new Error("Import batch changed during reconciliation");
      }
      const now = new Date();
      for (const row of rows) {
        const [updated] = await tx
          .update(importRows)
          .set({
            parsed: persistedRow(row),
            validationState: databaseValidationState(row.validationState),
            matchConfidence: row.duplicateCandidate?.score,
            proposedFlight: row.proposedFlight,
            userDecision: row.decision,
            decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(importRows.id, row.id),
              eq(importRows.batchId, batchId),
              eq(importRows.userId, userId),
            ),
          )
          .returning({ id: importRows.id });
        if (!updated) throw new Error("Import row not found");
      }
      await tx
        .delete(duplicateCandidates)
        .where(
          and(
            eq(duplicateCandidates.userId, userId),
            eq(duplicateCandidates.batchId, batchId),
          ),
        );
      await persistDuplicateCandidates(tx, userId, batchId, rows);
      const [updatedBatch] = await tx
        .update(importBatches)
        .set({ updatedAt: now })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .returning();
      if (!updatedBatch) throw new Error("Import batch not found");
      return summarize(tx, userId, updatedBatch);
    });
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
    return this.runWithUserDb(userId, async (tx) => {
      const [batchForDecision] = await tx
        .select({ id: importBatches.id, status: importBatches.status })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1);
      if (!batchForDecision) throw new Error("Import batch not found");
      if (batchForDecision.status !== "review") {
        throw new Error("Import batch is not in review");
      }

      const now = new Date();
      for (const decision of decisions) {
        const [stored] = await tx
          .select()
          .from(importRows)
          .where(
            and(
              eq(importRows.id, decision.rowId),
              eq(importRows.batchId, batchId),
              eq(importRows.userId, userId),
            ),
          )
          .limit(1);
        if (!stored) throw new Error("Import row not found");
        const restored = restoreRow(stored);
        if (restored.duplicateCandidate) {
          if (
            decision.action === "accepted" &&
            !decision.duplicateResolution
          ) {
            throw new Error("Duplicate resolution is required");
          }
          if (decision.duplicateResolution) {
            restored.duplicateCandidate.resolution =
              decision.duplicateResolution;
          }
        } else if (decision.duplicateResolution) {
          throw new Error("A non-duplicate row cannot have a duplicate resolution");
        }
        restored.decision = decision.action;
        restored.decidedAt = now.toISOString();
        const [updated] = await tx
          .update(importRows)
          .set({
            parsed: persistedRow(restored),
            userDecision: decision.action,
            decidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(importRows.id, decision.rowId),
              eq(importRows.batchId, batchId),
              eq(importRows.userId, userId),
            ),
          )
          .returning({ id: importRows.id });
        if (!updated) throw new Error("Import row not found");
        if (restored.duplicateCandidate && decision.duplicateResolution) {
          await tx
            .update(duplicateCandidates)
            .set({
              resolution: decision.duplicateResolution,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(duplicateCandidates.userId, userId),
                eq(duplicateCandidates.batchId, batchId),
                eq(duplicateCandidates.importRowId, decision.rowId),
              ),
            );
        }
      }
      const [batch] = await tx
        .update(importBatches)
        .set({ updatedAt: now })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
          ),
        )
        .returning();
      if (!batch) throw new Error("Import batch not found");
      return summarize(tx, userId, batch);
    });
  }

  async findDuplicateCandidates(
    userId: string,
    rows: StoredImportRow[],
  ): Promise<ExistingFingerprintCandidate[]> {
    const dates = [
      ...new Set(
        rows.flatMap((row) =>
          row.proposedFlight.date
            ? [row.proposedFlight.date.slice(0, 10)]
            : [],
        ),
      ),
    ];
    if (dates.length === 0) return [];
    return this.runWithUserDb(userId, async (tx) => {
      const matches = await tx
        .select()
        .from(flightTable)
        .where(
          and(
            eq(flightTable.userId, userId),
            inArray(flightTable.date, dates),
          ),
        );
      if (matches.length === 0) return [];
      // Stops are read before the airport catalog query so intermediate stop
      // airports are part of the `airportIds` union; loading only the
      // endpoints leaves multi-stop routes unresolvable. listFlights uses the
      // same ordering for the same reason.
      const stopRows = await tx
        .select()
        .from(flightStops)
        .where(
          and(
            eq(flightStops.userId, userId),
            inArray(
              flightStops.flightId,
              matches.map(({ id }) => id),
            ),
          ),
        )
        .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder));
      const airportIds = [
        ...new Set([
          ...matches.flatMap((flight) => [
            flight.originAirportId,
            flight.destinationAirportId,
          ]),
          ...stopRows.map((stop) => stop.airportId),
        ]),
      ];
      const airportRows = await tx
        .select()
        .from(airports)
        .where(inArray(airports.id, airportIds));
      const airportById = new Map(
        airportRows.map((airport) => [airport.id, airport]),
      );
      const stopsByFlight = new Map<string, typeof stopRows>();
      for (const stop of stopRows) {
        const stops = stopsByFlight.get(stop.flightId) ?? [];
        stops.push(stop);
        stopsByFlight.set(stop.flightId, stops);
      }
      return matches.map((match) => {
        const stops = stopsByFlight.get(match.id);
        const fingerprint = {
          algorithm: "sha256" as const,
          version: 1,
          value: match.fingerprint,
        };
        // An existing flight whose airport catalog metadata cannot be
        // rendered must not abort duplicate assessment for the whole upload.
        // The candidate is still returned without a route so exact-fingerprint
        // dedupe keeps working (ExistingFingerprintCandidate.flight is
        // optional precisely for this); it is never fabricated from the
        // endpoints, which would invent a route the pilot did not fly.
        const unresolvable = unresolvableRouteAirportIds(
          match,
          airportById,
          stops,
        );
        if (unresolvable.length > 0) {
          console.warn("import-duplicate-candidate-route-unresolved", {
            flightId: match.id,
            unresolvedAirportIds: unresolvable,
          });
          return { flightId: match.id, fingerprint };
        }
        return {
          flightId: match.id,
          fingerprint,
          flight: databaseFlightProposal(match, airportById, stops),
        };
      });
    });
  }

  async commitAcceptedImport(
    userId: string,
    input: CommitAcceptedImportInput,
  ): Promise<CommitAcceptedImportResult> {
    return this.runWithUserDb(userId, async (tx) => {
      const [batch] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.id, input.batch.id),
            eq(importBatches.userId, userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!batch) throw new Error("Import batch not found");
      if (batch.status === "committed") {
        return {
          batchId: batch.id,
          status: "committed",
          acceptedRows: batch.acceptedRows,
          createdFlights: batch.importedRows,
          attachedSources: 0,
        };
      }
      if (batch.status !== "review") {
        throw new Error("Import batch is not in review");
      }

      const databaseRows = await tx
        .select()
        .from(importRows)
        .where(
          and(
            eq(importRows.userId, userId),
            eq(importRows.batchId, batch.id),
          ),
        );
      const accepted = databaseRows
        .filter((row) => row.userDecision === "accepted")
        .map(restoreRow);

      let createdFlights = 0;
      let attachedSources = 0;
      const resolvedFlightByRow = new Map<string, string>();
      for (const row of accepted) {
        const rowFingerprint = row.rowFingerprint;
        const airportIds = resolvedAirportIds(row.proposedFlight);
        const originAirportId = airportIds[0];
        const destinationAirportId = airportIds.at(-1);
        if (
          !row.commitReady ||
          !rowFingerprint ||
          !row.proposedFlight.date ||
          !originAirportId ||
          !destinationAirportId
        ) {
          throw new Error("An accepted row is not commit-ready");
        }
        if (row.duplicateCandidate?.resolution === "pending") {
          throw new Error("Duplicate resolution is required");
        }

        let flightId: string;
        let createdThisRow = false;
        if (row.duplicateCandidate?.resolution === "skip_as_duplicate") {
          if (row.duplicateCandidate.scope === "existing-flight") {
            const [target] = await tx
              .select({ id: flightTable.id })
              .from(flightTable)
              .where(
                and(
                  eq(flightTable.id, row.duplicateCandidate.candidateId),
                  eq(flightTable.userId, userId),
                ),
              )
              .limit(1);
            if (!target) {
              throw new Error("The selected duplicate target is unavailable");
            }
            flightId = target.id;
          } else {
            const target = resolvedFlightByRow.get(
              row.duplicateCandidate.candidateId,
            );
            if (!target) {
              throw new Error(
                "The selected staged duplicate must be committed first",
              );
            }
            flightId = target;
          }
        } else {
          const fingerprint =
            row.duplicateCandidate?.resolution === "accept_new"
              ? createAcceptedDuplicateFingerprint(
                  userId,
                  row.id,
                  rowFingerprint,
                ).value
              : rowFingerprint.value;
          let [storedFlight] = await tx
            .select({ id: flightTable.id })
            .from(flightTable)
            .where(
              and(
                eq(flightTable.userId, userId),
                eq(flightTable.fingerprint, fingerprint),
              ),
            )
            .limit(1);
          if (!storedFlight) {
            [storedFlight] = await tx
              .insert(flightTable)
              .values({
                userId,
                fingerprint,
                date: row.proposedFlight.date,
                originAirportId,
                destinationAirportId,
                kind: row.proposedFlight.kind,
                role: row.proposedFlight.role,
                roleOrigin:
                  row.corrections?.some(
                    ({ field }) => field === "kind" || field === "role",
                  )
                    ? "explicit"
                    : row.proposedFlight.classificationOrigin ??
                      "legacy-unresolved",
                sourceType: row.proposedFlight.source,
                aircraft:
                  row.proposedFlight.aircraft ??
                  row.proposedFlight.aircraftModel,
                aircraftType: row.proposedFlight.aircraftType,
                registration: row.proposedFlight.registration,
                flightNumber: row.proposedFlight.flightNumber,
                airline: row.proposedFlight.airline,
                departureTime: row.proposedFlight.departureTime,
                distanceMiles: row.proposedFlight.distanceMiles,
                durationHours: row.proposedFlight.durationHours,
              })
              .onConflictDoNothing()
              .returning({ id: flightTable.id });
            if (storedFlight) {
              createdFlights += 1;
              createdThisRow = true;
              await insertFlightStops(
                tx,
                userId,
                storedFlight.id,
                airportIds,
              );
            } else {
              [storedFlight] = await tx
                .select({ id: flightTable.id })
                .from(flightTable)
                .where(
                  and(
                    eq(flightTable.userId, userId),
                    eq(flightTable.fingerprint, fingerprint),
                  ),
                )
                .limit(1);
            }
          }
          if (!storedFlight) {
            throw new Error("Committed flight could not be resolved");
          }
          flightId = storedFlight.id;
          if (createdThisRow && (row.corrections?.length ?? 0) > 0) {
            await tx.insert(flightOverrides).values(
              row.corrections!.map((correction) => ({
                userId,
                flightId,
                field: correction.field,
                originalValue: correction.originalValue ?? null,
                correctedValue:
                  correction.correctedValue === undefined
                    ? { cleared: true }
                    : correction.correctedValue,
                actor: `import-row:${row.id}`,
                reason: "Corrected during import review",
              })),
            );
          }
        }

        const insertedSource = await tx
          .insert(flightSources)
          .values({
            userId,
            flightId,
            batchId: batch.id,
            importRowId: row.id,
            sourceType: row.provenance.source,
            externalStableId: row.provenance.externalStableId,
          })
          .onConflictDoNothing()
          .returning({ id: flightSources.id });
        if (insertedSource.length > 0 && !createdThisRow) {
          attachedSources += 1;
        }
        resolvedFlightByRow.set(row.id, flightId);
        if (row.duplicateCandidate) {
          const candidateFlightId =
            row.duplicateCandidate.scope === "existing-flight"
              ? row.duplicateCandidate.candidateId
              : resolvedFlightByRow.get(row.duplicateCandidate.candidateId);
          await tx
            .update(duplicateCandidates)
            .set({
              flightAId: flightId,
              flightBId: candidateFlightId,
              resolution: row.duplicateCandidate.resolution,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(duplicateCandidates.userId, userId),
                eq(duplicateCandidates.batchId, batch.id),
                eq(duplicateCandidates.importRowId, row.id),
              ),
            );
        }
      }

      const committedAt = new Date();
      await scrubDecidedRawSnapshots(tx, userId, batch.id, committedAt);
      const status = databaseRows.some(
        (row) => row.userDecision === "pending",
      )
        ? "review"
        : "committed";
      await tx
        .update(importBatches)
        .set({
          status,
          acceptedRows: accepted.length,
          importedRows: batch.importedRows + createdFlights,
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(importBatches.id, batch.id),
            eq(importBatches.userId, userId),
          ),
        );
      return {
        batchId: batch.id,
        status,
        acceptedRows: accepted.length,
        createdFlights,
        attachedSources,
      };
    });
  }
}

type BatchRow = typeof importBatches.$inferSelect;
type ImportRow = typeof importRows.$inferSelect;
type AirportRow = typeof airports.$inferSelect;
type FlightRow = typeof flightTable.$inferSelect;

async function persistDuplicateCandidates(
  tx: DatabaseTransaction,
  userId: string,
  batchId: string,
  rows: StoredImportRow[],
): Promise<void> {
  const candidates = rows.flatMap((row) =>
    row.duplicateCandidate
      ? [{
          userId,
          batchId,
          importRowId: row.id,
          candidateImportRowId:
            row.duplicateCandidate.scope === "staged-row"
              ? row.duplicateCandidate.candidateId
              : null,
          candidateFlightId:
            row.duplicateCandidate.scope === "existing-flight"
              ? row.duplicateCandidate.candidateId
              : null,
          candidateScope: row.duplicateCandidate.scope,
          ruleVersion: row.duplicateCandidate.ruleVersion,
          score: row.duplicateCandidate.score,
          explanation: {
            summary: row.duplicateCandidate.explanation,
            signals: row.duplicateCandidate.signals,
          },
          resolution: row.duplicateCandidate.resolution,
          resolvedAt:
            row.duplicateCandidate.resolution === "pending" ? null : new Date(),
        }]
      : [],
  );
  if (candidates.length > 0) {
    await tx.insert(duplicateCandidates).values(candidates);
  }
}

// The private objects a batch is still responsible for. Kept in one place so
// cleanup discovery and supersession can never disagree about what to delete.
function objectKeysFor(batch: {
  originalObjectKey: string | null;
  quarantineObjectKey: string | null;
}): string[] {
  return [
    ...new Set(
      [batch.originalObjectKey, batch.quarantineObjectKey].filter(
        (key): key is string => Boolean(key),
      ),
    ),
  ];
}

async function scrubRawSnapshots(
  tx: DatabaseTransaction,
  userId: string,
  batchId: string,
  updatedAt: Date,
): Promise<void> {
  await tx
    .update(importRows)
    .set({ rawSnapshot: null, updatedAt })
    .where(
      and(eq(importRows.userId, userId), eq(importRows.batchId, batchId)),
    );
}

async function scrubDecidedRawSnapshots(
  tx: DatabaseTransaction,
  userId: string,
  batchId: string,
  updatedAt: Date,
): Promise<void> {
  await tx
    .update(importRows)
    .set({ rawSnapshot: null, updatedAt })
    .where(
      and(
        eq(importRows.userId, userId),
        eq(importRows.batchId, batchId),
        ne(importRows.userDecision, "pending"),
      ),
    );
}

async function summarize(
  tx: DatabaseTransaction,
  userId: string,
  batch: BatchRow,
): Promise<ImportBatchSummary> {
  const rows = await tx
    .select()
    .from(importRows)
    .where(
      and(eq(importRows.userId, userId), eq(importRows.batchId, batch.id)),
    );
  const restored = rows.map(restoreRow);
  const sources = await tx
    .select({ flightId: flightSources.flightId })
    .from(flightSources)
    .where(
      and(
        eq(flightSources.userId, userId),
        eq(flightSources.batchId, batch.id),
      ),
    );
  const counts: ImportBatchCounts = {
    totalRows: rows.length || batch.totalRows,
    parsedRows: rows.length || batch.parsedRows,
    readyRows: restored.filter((row) => row.commitReady).length,
    acceptedRows: rows.filter((row) => row.userDecision === "accepted").length,
    skippedRows: rows.filter((row) => row.userDecision === "skipped").length,
    pendingRows: rows.filter((row) => row.userDecision === "pending").length,
    unresolvedDuplicateRows: restored.filter(
      (row) =>
        row.duplicateCandidate?.resolution === "pending" &&
        row.decision !== "skipped",
    ).length,
    importedRows: batch.importedRows,
    duplicateRows: restored.filter(
      (row) =>
        row.decision === "skipped" &&
        row.duplicateCandidate?.resolution === "skip_as_duplicate",
    ).length,
    invalidRows: restored.filter((row) => !row.commitReady).length,
    reviewRequiredRows: restored.filter(
      (row) => row.decision === "pending",
    ).length,
    committedFlights: new Set(sources.map((source) => source.flightId)).size,
    attachedSources: sources.length,
  };
  return {
    contractVersion: IMPORT_CONTRACT_VERSION,
    id: batch.id,
    fileName: batch.originalFileName,
    adapterId:
      batch.adapterId === "pending-detection" ? undefined : batch.adapterId,
    adapterLabel: adapterLabel(batch.adapterId),
    adapterVersion: batch.adapterVersion || undefined,
    source: adapterSource(batch.adapterId),
    status: batch.status as ImportBatchStatus,
    duplicateOfBatchId: batch.duplicateOfBatchId ?? undefined,
    counts,
    error:
      batch.failureCode || batch.failureMessage
        ? {
            code: batch.failureCode ?? "import-failed",
            message: batch.failureMessage ?? "The import failed.",
          }
        : undefined,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}

function persistedRow(row: StoredImportRow): Omit<StoredImportRow, "rawSnapshot"> {
  const persisted = { ...row } as Partial<StoredImportRow>;
  delete persisted.rawSnapshot;
  return persisted as Omit<StoredImportRow, "rawSnapshot">;
}

function restoreRow(row: ImportRow): StoredImportRow {
  const parsed = row.parsed as Omit<StoredImportRow, "rawSnapshot">;
  return {
    ...parsed,
    id: row.id,
    batchId: row.batchId,
    rowNumber: row.rowNumber,
    rawSnapshot: Array.isArray(row.rawSnapshot)
      ? row.rawSnapshot.map(String)
      : null,
    proposedFlight: row.proposedFlight as ProposedImportFlight,
    decision:
      row.userDecision === "accepted"
        ? "accepted"
        : row.userDecision === "skipped"
          ? "skipped"
          : "pending",
    decidedAt: row.decidedAt?.toISOString(),
  };
}

function databaseValidationState(
  state: StoredImportRow["validationState"],
): "valid" | "warning" | "invalid" | "duplicate" {
  if (state === "ready") return "valid";
  if (state === "warning") return "warning";
  if (state === "duplicate") return "duplicate";
  return "invalid";
}

function adapterLabel(adapterId: string): string | undefined {
  if (adapterId === "foreflight-v1") return "ForeFlight Logbook Import";
  if (adapterId === "myflightradar24-v1") {
    return "myFlightradar24 Flight Diary CSV";
  }
  if (adapterId === "generic-csv-v1") return "Generic mapped CSV";
  return adapterId === "pending-detection" ? undefined : adapterId;
}

function adapterSource(
  adapterId: string,
): ImportBatchSummary["source"] | undefined {
  if (adapterId === "foreflight-v1") return "ForeFlight";
  if (adapterId === "myflightradar24-v1") return "FlightRadar24";
  if (adapterId === "generic-csv-v1") return "CSV";
  return undefined;
}

function airportCode(row: AirportRow): string {
  const code = preferredAirportCode(row);
  if (!code) throw new Error("Airport has no safe display identifier");
  return code;
}

function toAirport(row: AirportRow): Airport {
  return {
    identity: row.id,
    code: airportCode(row),
    name: row.name,
    city: row.city ?? row.name,
    country: row.country,
    lat: row.latitude,
    lon: row.longitude,
    facility: row.facility as Airport["facility"],
  };
}

function routeAirportIds(
  row: FlightRow,
  stopRows?: Array<typeof flightStops.$inferSelect>,
): string[] {
  return stopRows && stopRows.length >= 2
    ? stopRows.map(({ airportId }) => airportId)
    : [row.originAirportId, row.destinationAirportId];
}

// Duplicate assessment is read-only enrichment: a candidate whose catalog
// metadata is missing or unusable is reported instead of thrown so one bad
// stored flight cannot fail an entire import. Returns the airport ids that
// databaseFlightProposal would not be able to render.
function unresolvableRouteAirportIds(
  row: FlightRow,
  airportById: Map<string, AirportRow>,
  stopRows?: Array<typeof flightStops.$inferSelect>,
): string[] {
  const required = [
    row.originAirportId,
    row.destinationAirportId,
    ...routeAirportIds(row, stopRows),
  ];
  return [
    ...new Set(
      required.filter((airportId) => {
        const airport = airportById.get(airportId);
        return !airport || !preferredAirportCode(airport);
      }),
    ),
  ];
}

function databaseFlightProposal(
  row: FlightRow,
  airportById: Map<string, AirportRow>,
  stopRows?: Array<typeof flightStops.$inferSelect>,
): ProposedImportFlight {
  const origin = airportById.get(row.originAirportId);
  const destination = airportById.get(row.destinationAirportId);
  if (!origin || !destination) {
    throw new Error("A duplicate candidate references a missing airport");
  }
  const airportMatches = routeAirportIds(row, stopRows).map((airportId) => {
    const airport = airportById.get(airportId);
    if (!airport) {
      throw new Error("A duplicate candidate route references a missing airport");
    }
    return {
      status: "resolved" as const,
      identifier: airportCode(airport),
      airportId: airport.id,
      airport: toAirport(airport),
    };
  });
  return {
    date: row.date,
    departureTime: row.departureTime ?? undefined,
    originIdentifier: airportCode(origin),
    destinationIdentifier: airportCode(destination),
    origin: {
      status: "resolved",
      identifier: airportCode(origin),
      airportId: origin.id,
      airport: toAirport(origin),
    },
    destination: {
      status: "resolved",
      identifier: airportCode(destination),
      airportId: destination.id,
      airport: toAirport(destination),
    },
    airportIdentifiers: airportMatches.map(({ identifier }) => identifier),
    airportMatches,
    kind: row.kind as ProposedImportFlight["kind"],
    role: row.role as ProposedImportFlight["role"],
    aircraft: row.aircraft ?? undefined,
    aircraftType: row.aircraftType ?? undefined,
    registration: row.registration ?? undefined,
    flightNumber: row.flightNumber ?? undefined,
    airline: row.airline ?? undefined,
    distanceMiles: row.distanceMiles ?? undefined,
    durationHours: row.durationHours ?? undefined,
    source: "CSV",
  };
}

function flightSource(value: string): FlightSource {
  if (
    value === "ForeFlight" ||
    value === "FlightRadar24" ||
    value === "Manual"
  ) {
    return value;
  }
  return "CSV";
}

function greatCircleMiles(origin: Airport, destination: Airport): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = radians(origin.lat);
  const lat2 = radians(destination.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(destination.lon - origin.lon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function routeDistanceMiles(sequence: Airport[]): number {
  return sequence
    .slice(0, -1)
    .reduce(
      (total, origin, index) =>
        total + greatCircleMiles(origin, sequence[index + 1]),
      0,
    );
}

function resolvedAirportIds(proposal: ProposedImportFlight): string[] {
  const matches =
    proposal.airportMatches && proposal.airportMatches.length >= 2
      ? proposal.airportMatches
      : proposal.origin && proposal.destination
        ? [proposal.origin, proposal.destination]
        : [];
  return matches.flatMap((match) =>
    match.status === "resolved" ? [match.airportId] : [],
  );
}

async function insertFlightStops(
  tx: DatabaseTransaction,
  userId: string,
  flightId: string,
  airportIds: string[],
): Promise<void> {
  if (airportIds.length < 2) {
    throw new Error("A committed flight requires at least two route stops");
  }
  await tx
    .insert(flightStops)
    .values(
      airportIds.map((airportId, stopOrder) => ({
        userId,
        flightId,
        stopOrder,
        airportId,
      })),
    )
    .onConflictDoNothing();
}
