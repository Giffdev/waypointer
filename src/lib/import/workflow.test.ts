import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { getInitialFilters } from "@/components/dashboard-shared";
import {
  buildPersistedFlightData,
  buildPersistedFlightStatisticsContext,
} from "../persisted-flight-data";
import {
  buildFlightsPageContract,
  buildMapPageContract,
} from "../route-page-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import {
  commitImportBatch,
  decideImportRows,
  getUserImportBatch,
} from "./service";
import { stageFlightImport } from "./worker";
import { applyProposalCorrection } from "./corrections";
import { applyDuplicateCandidates } from "./dedupe";
import { createRowFingerprint } from "./fingerprint";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "./review";

const fixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/foreflight-v1.csv", import.meta.url)),
  "utf8",
);

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Test",
  country: "US",
  lat: 40,
  lon: -75,
  facility: "general-aviation",
});

function repository() {
  return new InMemoryImportRepository([
    { id: "airport-kaaa", airport: airport("KAAA"), aliases: ["KAAA"] },
    { id: "airport-kbbb", airport: airport("KBBB"), aliases: ["KBBB"] },
    { id: "airport-kccc", airport: airport("KCCC"), aliases: ["KCCC"] },
  ]);
}

describe("web import workflow", () => {
  it("stages, decides, commits, deduplicates, and isolates users", async () => {
    const store = repository();
    const repositories = { imports: store, flights: store, airports: store };
    const first = await stageFlightImport(
      "user-a",
      {
        fileName: "logbook.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      repositories,
    );

    expect(first).toMatchObject({ status: "review", reused: false });
    const staged = await getUserImportBatch(
      "user-a",
      first.batchId,
      1,
      25,
      store,
    );
    expect(staged?.adapterId).toBe("foreflight-v1");
    expect(staged?.adapterVersion).toBe(1);
    expect(staged?.rows.rows[0].rawSnapshot).not.toBeNull();
    expect(
      await getUserImportBatch("user-b", first.batchId, 1, 25, store),
    ).toBeNull();

    await decideImportRows(
      "user-a",
      first.batchId,
      {
        decisions:
          staged?.rows.rows.map((row) => ({
            rowId: row.id,
            action: row.commitReady
              ? ("accepted" as const)
              : ("skipped" as const),
          })) ?? [],
      },
      store,
    );
    expect(
      await commitImportBatch("user-a", first.batchId, store, store),
    ).toMatchObject({ batchId: first.batchId, status: "committed" });
    const committed = await getUserImportBatch(
      "user-a",
      first.batchId,
      1,
      25,
      store,
    );
    expect(committed?.status).toBe("committed");
    expect(committed?.counts.committedFlights).toBeGreaterThan(0);
    expect(
      committed?.rows.rows.every((row) => row.rawSnapshot === null),
    ).toBe(true);
    const savedFlights = await store.listFlights("user-a");
    expect(savedFlights).toHaveLength(
      committed?.counts.committedFlights ?? 0,
    );
    expect(await store.listFlights("user-b")).toEqual([]);
    const persistedData = buildPersistedFlightData(
      savedFlights,
      "2026-08-11T00:00:00.000Z",
    );
    const statistics = buildPersistedFlightStatisticsContext(
      savedFlights,
      new Date("2026-08-11T00:00:00.000Z"),
    );
    const map = buildMapPageContract(
      getInitialFilters(),
      persistedData,
      statistics,
    );
    const flightsPage = buildFlightsPageContract(
      getInitialFilters(),
      persistedData,
      statistics,
    );
    expect(map.dataMode).toBe("persisted");
    expect(map.filteredFlightCount).toBe(savedFlights.length);
    expect(flightsPage.flights.map((flight) => flight.id).sort()).toEqual(
      savedFlights.map((flight) => flight.id).sort(),
    );

    const repeated = await stageFlightImport(
      "user-a",
      {
        fileName: "renamed.csv",
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      repositories,
    );
    expect(repeated).toEqual({
      batchId: first.batchId,
      status: "committed",
      reused: true,
    });

    const secondFile = await stageFlightImport(
      "user-a",
      {
        fileName: "same-rows.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(`${fixture}\n`),
        content: `${fixture}\n`,
      },
      repositories,
    );
    const duplicateReview = await getUserImportBatch(
      "user-a",
      secondFile.batchId,
      1,
      25,
      store,
    );
    expect(
      duplicateReview?.rows.rows.some(
        (row) => row.validationState === "duplicate",
      ),
    ).toBe(true);
    await decideImportRows(
      "user-a",
      secondFile.batchId,
      {
        decisions:
          duplicateReview?.rows.rows.map((row) => ({
            rowId: row.id,
            action: row.commitReady
              ? ("accepted" as const)
              : ("skipped" as const),
            duplicateResolution: row.duplicateCandidate
              ? ("skip_as_duplicate" as const)
              : undefined,
          })) ?? [],
      },
      store,
    );
    await commitImportBatch("user-a", secondFile.batchId, store, store);
    expect(await store.listFlights("user-a")).toHaveLength(savedFlights.length);
    expect(
      (
        await getUserImportBatch(
          "user-a",
          secondFile.batchId,
          1,
          25,
          store,
        )
      )?.counts.attachedSources,
    ).toBeGreaterThan(0);

    const otherUser = await stageFlightImport(
      "user-b",
      {
        fileName: "logbook.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      repositories,
    );
    expect(otherUser.batchId).not.toBe(first.batchId);
    const otherReview = await getUserImportBatch(
      "user-b",
      otherUser.batchId,
      1,
      25,
      store,
    );
    expect(
      otherReview?.rows.rows.every((row) => !row.duplicateCandidate),
    ).toBe(true);
  });

  it("stages the same bytes again after a failed attempt and still reuses successes", async () => {
    const store = repository();
    const repositories = { imports: store, flights: store, airports: store };
    const upload = {
      fileName: "logbook.csv",
      mimeType: "text/csv",
      sizeBytes: Buffer.byteLength(fixture),
      content: fixture,
    };
    const failedAttempt = await stageFlightImport(
      "user-a",
      upload,
      repositories,
    );
    await store.failBatch("user-a", failedAttempt.batchId, {
      code: "processing-failed",
      message: "The file could not be staged for review.",
    });

    const retry = await stageFlightImport("user-a", upload, repositories);
    expect(retry).toMatchObject({ status: "review", reused: false });
    expect(retry.batchId).not.toBe(failedAttempt.batchId);
    expect((await store.getBatch("user-a", failedAttempt.batchId))?.status).toBe(
      "expired",
    );

    const repeated = await stageFlightImport("user-a", upload, repositories);
    expect(repeated).toEqual({
      batchId: retry.batchId,
      status: "review",
      reused: true,
    });
  });

  it("scrubs review snapshots when a failed batch ages out", async () => {
    const store = repository();
    const repositories = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport(
      "user-a",
      {
        fileName: "logbook.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      repositories,
    );
    const staged = await getUserImportBatch(
      "user-a",
      result.batchId,
      1,
      25,
      store,
    );
    expect(staged?.rows.rows.some((row) => row.rawSnapshot !== null)).toBe(true);

    await store.failBatch("user-a", result.batchId, {
      code: "aged-failure",
      message: "Synthetic failure",
    });
    await store.scrubBatchRawSnapshots("user-a", result.batchId);
    const scrubbedFailure = await getUserImportBatch(
      "user-a",
      result.batchId,
      1,
      25,
      store,
    );
    expect(scrubbedFailure?.status).toBe("failed");
    expect(
      scrubbedFailure?.rows.rows.every((row) => row.rawSnapshot === null),
    ).toBe(true);

    await store.expireBatchAndScrub("user-a", result.batchId);

    const expired = await getUserImportBatch(
      "user-a",
      result.batchId,
      1,
      25,
      store,
    );
    expect(expired?.status).toBe("expired");
    expect(expired?.rows.rows.every((row) => row.rawSnapshot === null)).toBe(
      true,
    );
  });

  it("prevents accepting an ambiguous airport match", async () => {
    const store = new InMemoryImportRepository([
      { id: "airport-a", airport: airport("AAA"), aliases: ["KAAA"] },
      { id: "airport-b", airport: airport("AAB"), aliases: ["KAAA"] },
      { id: "airport-kbbb", airport: airport("KBBB"), aliases: ["KBBB"] },
    ]);
    const result = await stageFlightImport(
      "user-a",
      {
        fileName: "ambiguous.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      { imports: store, flights: store, airports: store },
    );
    const detail = await getUserImportBatch(
      "user-a",
      result.batchId,
      1,
      25,
      store,
    );
    const ambiguous = detail?.rows.rows.find(
      (row) => row.validationState === "ambiguous",
    );
    expect(ambiguous).toBeDefined();
    await expect(
      decideImportRows(
        "user-a",
        result.batchId,
        { decisions: [{ rowId: ambiguous?.id ?? "", action: "accepted" }] },
        store,
      ),
    ).rejects.toThrow(/cannot be accepted/);
  });

  it("corrects a staged airport without mutating source truth and persists an override", async () => {
    const store = repository();
    const repositories = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport(
      "user-a",
      {
        fileName: "correct.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(fixture),
        content: fixture,
      },
      repositories,
    );
    const rows = (await store.getRowsForCommit("user-a", result.batchId)) ?? [];
    const sourceSnapshot = structuredClone(rows[0].rawSnapshot);
    const selected = await store.findById("user-a", "airport-kccc");
    expect(selected?.status).toBe("resolved");
    const corrected = applyProposalCorrection(
      rows[0],
      { origin: selected ?? undefined },
      "2026-08-12T18:00:00.000Z",
    );
    corrected.commitReady = isImportProposalCommitReady(
      corrected.proposedFlight,
      corrected.issues,
    );
    corrected.validationState = importProposalValidationState(
      corrected.proposedFlight,
      corrected.issues,
    );
    corrected.rowFingerprint = createRowFingerprint(
      "user-a",
      corrected.proposedFlight,
    );
    rows[0] = corrected;
    const rescored = applyDuplicateCandidates(
      rows,
      await store.findDuplicateCandidates("user-a", rows),
    );
    await store.replaceReviewRows("user-a", result.batchId, rescored);
    const reviewed = await store.getRowsForCommit("user-a", result.batchId);
    expect(reviewed?.[0].rawSnapshot).toEqual(sourceSnapshot);
    await decideImportRows(
      "user-a",
      result.batchId,
      {
        decisions:
          reviewed?.map((row, index) => ({
            rowId: row.id,
            action: index === 0 ? ("accepted" as const) : ("skipped" as const),
            duplicateResolution:
              index === 0 && row.duplicateCandidate
                ? ("accept_new" as const)
                : undefined,
          })) ?? [],
      },
      store,
    );
    await commitImportBatch("user-a", result.batchId, store, store);
    expect(store.listCorrectionOverrides("user-a")).toEqual([
      expect.objectContaining({ rowId: rows[0].id, field: "origin" }),
    ]);
    expect(
      (await store.getRowsForCommit("user-a", result.batchId))?.every(
        (row) => row.rawSnapshot === null,
      ),
    ).toBe(true);
    expect(store.listCorrectionOverrides("user-b")).toEqual([]);
  });
});
