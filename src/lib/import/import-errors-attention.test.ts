import { describe, expect, it, vi } from "vitest";

// `response.ts` pulls in the auth guards, which pull in next-auth's server
// entrypoint. The error mapping under test has nothing to do with auth, so the
// guard module is stubbed to keep this a unit test.
vi.mock("@/lib/auth/guards", () => ({
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));

import { importApiError } from "@/app/api/import/_lib/response";
import { ImportServiceError } from "@/app/api/import/_lib/service";
import {
  IMPORT_ATTENTION_HREF,
  summarizePendingImportAttention,
} from "./attention";
import {
  ImportInvariantError,
  importInvariantStatus,
  isImportInvariantError,
} from "./errors";
import type { ImportBatchSummary } from "./types";

describe("typed commit invariant errors", () => {
  it("maps every invariant code to a client-fault status, never 503", () => {
    // 503 means "come back later". An invariant break never resolves by
    // waiting, so reporting it that way both misleads the user and hides a
    // real defect behind a transient-looking status.
    const codes = [
      "route-stop-unresolved",
      "route-stop-invalid",
      "batch-not-committable",
      "row-not-commit-ready",
      "batch-not-found",
      "row-not-found",
      "duplicate-resolution-required",
      "duplicate-target-unavailable",
      "duplicate-order-violation",
    ] as const;
    for (const code of codes) {
      const status = importInvariantStatus(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    expect(importInvariantStatus("route-stop-unresolved")).toBe(422);
    expect(importInvariantStatus("batch-not-committable")).toBe(409);
  });

  it("is recognisable across module boundaries", () => {
    const error = new ImportInvariantError("route-stop-unresolved", "nope");
    expect(isImportInvariantError(error)).toBe(true);
    expect(isImportInvariantError(new Error("nope"))).toBe(false);
  });

  it("renders 422 for an unresolved route stop", async () => {
    const response = importApiError(
      new ImportInvariantError(
        "route-stop-unresolved",
        "Every landing airport must be resolved before a flight is committed.",
      ),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "route-stop-unresolved" },
    });
  });

  it("renders 409 for a batch that is not committable", async () => {
    const response = importApiError(
      new ImportInvariantError("batch-not-committable", "Not ready."),
    );
    expect(response.status).toBe(409);
  });

  it("renders 500 with a correlation id for a genuinely unexpected throw", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const thrown = new Error("KMFR row 42 for N12345 is malformed");
    const response = importApiError(thrown);
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; correlationId: string; message: string };
    };
    expect(body.error.code).toBe("internal-error");
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // The correlation id makes the failure attributable without putting a
    // single cell of anybody's logbook into a log line.
    expect(body.error.message).not.toContain("malformed");

    // The log carries the stack, because a bare error name is not something
    // anyone can debug — but not the message, which routinely quotes the
    // offending airport, registration, or CSV cell.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [label, payload] = consoleError.mock.calls[0] as [
      string,
      { correlationId: string; name: string; stack?: string },
    ];
    expect(label).toBe("import.unhandled-error");
    expect(payload.name).toBe("Error");
    expect(payload.stack).toContain("at ");
    expect(payload.stack).not.toContain("KMFR");
    expect(payload.stack).not.toContain("N12345");
    expect(JSON.stringify(payload)).not.toContain("malformed");
    consoleError.mockRestore();
  });

  it("logs nothing beyond a name for a non-Error throw", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = importApiError("KMFR,N12345,raw row text");
    expect(response.status).toBe(500);
    const [, payload] = consoleError.mock.calls[0] as [
      string,
      { name: string; stack?: string },
    ];
    expect(payload.name).toBe("string");
    expect(payload.stack).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("N12345");
    consoleError.mockRestore();
  });

  it("still honours explicit service statuses", async () => {
    const response = importApiError(
      new ImportServiceError(410, "upload-expired", "The upload expired."),
    );
    expect(response.status).toBe(410);
  });
});

describe("pending import attention", () => {
  const batch = (
    overrides: Partial<ImportBatchSummary> = {},
  ): ImportBatchSummary =>
    ({
      id: "batch-1",
      status: "review",
      fileName: "logbook.csv",
      createdAt: "2026-05-01T00:00:00.000Z",
      counts: {
        totalRows: 10,
        pendingRows: 3,
        acceptedRows: 5,
        skippedRows: 2,
        invalidRows: 0,
        duplicateRows: 2,
        unresolvedDuplicateRows: 2,
        routeWaypointRows: 4,
        unresolvedRouteTokenRows: 1,
        adoptedFlightRows: 0,
        ...(overrides.counts ?? {}),
      },
      ...overrides,
    }) as ImportBatchSummary;

  it("counts only batches that are actually waiting on a person", () => {
    const attention = summarizePendingImportAttention([
      batch(),
      batch({ id: "batch-2", status: "committed" }),
    ]);
    expect(attention).toMatchObject({
      reviewBatches: 1,
      pendingRows: 3,
      unresolvedDuplicateRows: 2,
      unresolvedRouteTokenRows: 1,
      href: IMPORT_ATTENTION_HREF,
    });
  });

  it("sums across every reviewable batch", () => {
    const attention = summarizePendingImportAttention([
      batch(),
      batch({ id: "batch-2" }),
    ]);
    expect(attention.reviewBatches).toBe(2);
    expect(attention.pendingRows).toBe(6);
    expect(attention.unresolvedDuplicateRows).toBe(4);
  });

  it("reports nothing to do when there is nothing to do", () => {
    expect(summarizePendingImportAttention([])).toMatchObject({
      reviewBatches: 0,
      pendingRows: 0,
      unresolvedDuplicateRows: 0,
      reprocessAvailableBatches: 0,
    });
  });

  it("surfaces batches eligible for reprocessing even once committed", () => {
    // A committed batch staged by an older importer is exactly the case the
    // user cannot discover on their own: nothing looks wrong, and the fix
    // that would help them has already shipped.
    const attention = summarizePendingImportAttention([
      batch({ id: "old", status: "committed", reprocessAvailable: true }),
    ]);
    expect(attention.reviewBatches).toBe(0);
    expect(attention.reprocessAvailableBatches).toBe(1);
  });
});
