/**
 * High-value integration tests for multi-user import security and correctness.
 * Covers: user isolation, upload validation, fingerprint/dedupe scoping,
 * idempotency per-user but not across users, atomic commit, and provenance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import {
  commitImportBatch,
  decideImportRows,
  getUserImportBatch,
  listUserImportBatches,
} from "./service";
import { stageFlightImport } from "./worker";

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
  ]);
}

function upload(content: string, opts?: { name?: string; mime?: string; size?: number }) {
  return {
    fileName: opts?.name ?? "logbook.csv",
    mimeType: opts?.mime ?? "text/csv",
    sizeBytes: opts?.size ?? Buffer.byteLength(content),
    content,
  };
}

describe("user isolation", () => {
  it("user A cannot list user B batches", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await stageFlightImport("user-a", upload(fixture), repos);
    const bList = await listUserImportBatches("user-b", store);
    expect(bList).toHaveLength(0);
  });

  it("user A cannot read user B batch by guessed UUID", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const batch = await getUserImportBatch("user-b", result.batchId, 1, 25, store);
    expect(batch).toBeNull();
  });

  it("user A cannot decide rows on user B batch", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const detail = await getUserImportBatch("user-a", result.batchId, 1, 25, store);
    const rowId = detail!.rows.rows[0].id;
    await expect(
      decideImportRows("user-b", result.batchId, {
        decisions: [{ rowId, action: "accepted" }],
      }, store),
    ).rejects.toThrow();
  });

  it("user A cannot replace corrected review rows on user B batch", async () => {
    const store = repository();
    const result = await stageFlightImport(
      "user-b",
      upload(fixture),
      { imports: store, flights: store, airports: store },
    );
    const rows = await store.getRowsForCommit("user-b", result.batchId);
    await expect(
      store.replaceReviewRows("user-a", result.batchId, rows ?? []),
    ).rejects.toThrow(/not found/);
  });

  it("user A cannot commit user B batch", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    await expect(
      commitImportBatch("user-b", result.batchId, store, store),
    ).rejects.toThrow();
  });
});

describe("upload validation", () => {
  it("rejects empty files", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-a", upload("", { size: 0 }), repos),
    ).rejects.toThrow();
  });

  it("rejects files exceeding max bytes", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport(
        "user-a",
        upload("x".repeat(100), { size: 20 * 1024 * 1024 }),
        repos,
        { maxBytes: 1024 },
      ),
    ).rejects.toThrow();
  });

  it("rejects binary content with null bytes", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-a", upload("binary\x00content"), repos),
    ).rejects.toThrow(/[Bb]inary/);
  });

  it("rejects unsupported MIME types", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-a", upload(fixture, { mime: "application/pdf" }), repos),
    ).rejects.toThrow(/MIME/);
  });

  it("rejects non-CSV extension", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-a", upload(fixture, { name: "logbook.xlsx" }), repos),
    ).rejects.toThrow(/CSV/);
  });

  it("rejects unrecognized format content", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport(
      "user-a",
      upload("col1,col2\nval1,val2\n"),
      repos,
    );
    expect(result.status).toBe("failed");
  });
});

describe("file-level idempotency scoping", () => {
  it("same file same user returns reused=true", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const first = await stageFlightImport("user-a", upload(fixture), repos);
    const second = await stageFlightImport("user-a", upload(fixture), repos);
    expect(second.reused).toBe(true);
    expect(second.batchId).toBe(first.batchId);
  });

  it("same file different user is NOT reused", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const first = await stageFlightImport("user-a", upload(fixture), repos);
    const second = await stageFlightImport("user-b", upload(fixture), repos);
    expect(second.reused).toBe(false);
    expect(second.batchId).not.toBe(first.batchId);
  });

  it("concurrent same-user uploads converge on one batch", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const results = await Promise.all([
      stageFlightImport("user-a", upload(fixture), repos),
      stageFlightImport("user-a", upload(fixture), repos),
    ]);

    expect(new Set(results.map((result) => result.batchId)).size).toBe(1);
    expect((await listUserImportBatches("user-a", store))).toHaveLength(1);
  });
});

describe("row fingerprint and dedupe", () => {
  it("fingerprints are user-scoped (user B sees no duplicates from user A commits)", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const resultA = await stageFlightImport("user-a", upload(fixture), repos);
    const detailA = await getUserImportBatch("user-a", resultA.batchId, 1, 100, store);
    await decideImportRows("user-a", resultA.batchId, {
      decisions: detailA!.rows.rows.map((r) => ({
        rowId: r.id,
        action: r.commitReady ? "accepted" as const : "skipped" as const,
      })),
    }, store);
    await commitImportBatch("user-a", resultA.batchId, store, store);

    // User B uploads same content — should have NO duplicate candidates
    const resultB = await stageFlightImport("user-b", upload(fixture), repos);
    const detailB = await getUserImportBatch("user-b", resultB.batchId, 1, 100, store);
    expect(
      detailB!.rows.rows.every((row) => !row.duplicateCandidate),
    ).toBe(true);
  });

  it("rows have provenance metadata", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const detail = await getUserImportBatch("user-a", result.batchId, 1, 100, store);
    for (const row of detail!.rows.rows) {
      expect(row.provenance.adapterId).toBe("foreflight-v1");
      expect(row.provenance.adapterVersion).toBe(1);
      expect(row.provenance.sourceRowNumber).toBeGreaterThan(0);
      expect(row.provenance.externalStableId).toBeDefined();
    }
  });
});

describe("atomic commit behavior", () => {
  it("finalizes a fully skipped batch without creating flights", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const detail = await getUserImportBatch("user-a", result.batchId, 1, 100, store);
    await decideImportRows("user-a", result.batchId, {
      decisions: detail!.rows.rows.map((r) => ({
        rowId: r.id,
        action: "skipped" as const,
      })),
    }, store);
    await expect(
      commitImportBatch("user-a", result.batchId, store, store),
    ).resolves.toMatchObject({
      status: "committed",
      completion: { importedRows: 0, skippedRows: detail!.rows.rows.length },
    });
    expect(await store.listFlights("user-a")).toEqual([]);
  });

  it("double commit is idempotent", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const detail = await getUserImportBatch("user-a", result.batchId, 1, 100, store);
    await decideImportRows("user-a", result.batchId, {
      decisions: detail!.rows.rows.map((r) => ({
        rowId: r.id,
        action: r.commitReady ? "accepted" as const : "skipped" as const,
      })),
    }, store);
    const first = await commitImportBatch("user-a", result.batchId, store, store);
    const second = await commitImportBatch("user-a", result.batchId, store, store);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      batchId: result.batchId,
      status: "committed",
    });
  });

  it("committed batch has correct flight counts", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    const result = await stageFlightImport("user-a", upload(fixture), repos);
    const detail = await getUserImportBatch("user-a", result.batchId, 1, 100, store);
    const readyRows = detail!.rows.rows.filter((r) => r.commitReady);
    await decideImportRows("user-a", result.batchId, {
      decisions: detail!.rows.rows.map((r) => ({
        rowId: r.id,
        action: r.commitReady ? "accepted" as const : "skipped" as const,
      })),
    }, store);
    await commitImportBatch("user-a", result.batchId, store, store);
    const committed = await getUserImportBatch("user-a", result.batchId, 1, 100, store);
    expect(committed!.status).toBe("committed");
    expect(committed!.counts.committedFlights).toBe(readyRows.length);
  });
});

describe("guards require non-empty userId", () => {
  it("rejects empty string userId", async () => {
    const store = repository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("", upload(fixture), repos),
    ).rejects.toThrow(/userId/);
  });

  it("rejects whitespace-only userId", async () => {
    const store = repository();
    await expect(
      listUserImportBatches("   ", store),
    ).rejects.toThrow(/userId/);
  });
});
