/**
 * Tests for API-layer guards: unauthenticated denial, origin checking,
 * error response mapping, and upload service-level validation (content type, binary).
 */
import { describe, expect, it } from "vitest";
import { assertSameOrigin, RequestOriginError } from "../auth/request";
import { ImportServiceError } from "../../app/api/import/_lib/service";
import { redactOwnerImportBatchDetail } from "./api-contract";
import type { OwnerImportBatchDetail } from "./types";

describe("assertSameOrigin", () => {
  it("passes when origin matches request URL", () => {
    const req = new Request("http://localhost:3000/api/import/upload", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(() => assertSameOrigin(req)).not.toThrow();
  });

  it("throws when origin is missing", () => {
    const req = new Request("http://localhost:3000/api/import/upload");
    expect(() => assertSameOrigin(req)).toThrow(RequestOriginError);
  });

  it("throws when origin does not match", () => {
    const req = new Request("http://localhost:3000/api/import/upload", {
      headers: { origin: "http://evil.com" },
    });
    expect(() => assertSameOrigin(req)).toThrow(RequestOriginError);
  });
});

describe("ImportServiceError mapping", () => {
  it("captures status and code", () => {
    const err = new ImportServiceError(413, "file-too-large", "Too big");
    expect(err.status).toBe(413);
    expect(err.code).toBe("file-too-large");
    expect(err.message).toBe("Too big");
  });

  describe("owner import API contract", () => {
    it("never serializes retained raw row snapshots to the browser", () => {
      const detail = {
        contractVersion: 1,
        id: "batch",
        fileName: "log.csv",
        status: "review",
        counts: {
          totalRows: 1,
          parsedRows: 1,
          readyRows: 0,
          acceptedRows: 0,
          skippedRows: 0,
          pendingRows: 1,
          unresolvedDuplicateRows: 0,
          committedFlights: 0,
          attachedSources: 0,
          routeWaypointRows: 0,
          unresolvedRouteTokenRows: 0,
          adoptedFlightRows: 0,
        },
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        rows: {
          page: 1,
          pageSize: 25,
          totalRows: 1,
          totalPages: 1,
          rows: [
            {
              id: "row",
              batchId: "batch",
              rowNumber: 2,
              rawSnapshot: ["private note", "N12345"],
              proposedFlight: {
                kind: "private",
                role: "pilot",
                source: "ForeFlight",
              },
              issues: [],
              validationState: "invalid",
              commitReady: false,
              decision: "pending",
              provenance: {
                adapterId: "foreflight-v1",
                adapterLabel: "ForeFlight",
                adapterVersion: 1,
                source: "ForeFlight",
                sourceRowNumber: 2,
              },
            },
          ],
        },
      } satisfies OwnerImportBatchDetail;

      const redacted = redactOwnerImportBatchDetail(detail);
      expect(redacted.rows.rows[0].rawSnapshot).toBeNull();
      expect(detail.rows.rows[0].rawSnapshot).toEqual([
        "private note",
        "N12345",
      ]);
      expect(JSON.stringify(redacted)).not.toContain("private note");
    });
  });
});

describe("upload content validation (service layer)", () => {
  it("rejects binary (null-byte) content via service decodeUpload path", async () => {
    // The service's decodeUpload function checks for null bytes.
    // We verify this indirectly by testing the worker-level validation.
    const { stageFlightImport } = await import("../import/worker");
    const { InMemoryImportRepository } = await import("../import/in-memory-repository");
    const store = new InMemoryImportRepository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-x", {
        fileName: "test.csv",
        mimeType: "text/csv",
        sizeBytes: 10,
        content: "a\x00b",
      }, repos),
    ).rejects.toThrow(/[Bb]inary/);
  });

  it("rejects application/pdf MIME type", async () => {
    const { stageFlightImport } = await import("../import/worker");
    const { InMemoryImportRepository } = await import("../import/in-memory-repository");
    const store = new InMemoryImportRepository();
    const repos = { imports: store, flights: store, airports: store };
    await expect(
      stageFlightImport("user-x", {
        fileName: "test.csv",
        mimeType: "application/pdf",
        sizeBytes: 5,
        content: "hello",
      }, repos),
    ).rejects.toThrow(/MIME/);
  });
});
