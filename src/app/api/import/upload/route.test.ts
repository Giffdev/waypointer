import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  createUpload: vi.fn(),
  revalidateOwnerFlightViews: vi.fn(),
  requireImportUser: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
  requireImportUser: mocks.requireImportUser,
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  RateLimitExceededError: class RateLimitExceededError extends Error {},
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/auth/request", () => ({
  RequestOriginError: class RequestOriginError extends Error {},
  assertSameOrigin: mocks.assertSameOrigin,
}));
vi.mock("../_lib/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../_lib/service")>();
  return {
    ...original,
    importService: { createUpload: mocks.createUpload },
  };
});
vi.mock("../_lib/revalidate", () => ({
  revalidateOwnerFlightViews: mocks.revalidateOwnerFlightViews,
}));

import { POST } from "./route";

function uploadRequest(contentLength?: number, mapping?: unknown) {
  const form = new FormData();
  form.set("file", new File(["origin,destination\nSEA,LAX\n"], "flights.csv", {
    type: "text/csv",
  }));
  if (mapping !== undefined) form.set("mapping", JSON.stringify(mapping));
  const headers = new Headers({ origin: "http://localhost:3000" });
  if (contentLength) headers.set("content-length", String(contentLength));
  return new Request("http://localhost:3000/api/import/upload", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("MVP import upload boundary", () => {
  beforeEach(() => {
    vi.stubEnv("IMPORT_MAX_BYTES", "1048576");
    mocks.assertSameOrigin.mockReset();
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.createUpload.mockReset().mockResolvedValue({
      batchId: "batch-id",
      status: "committed",
      reused: false,
    });
    mocks.revalidateOwnerFlightViews.mockReset();

    afterEach(() => {
      vi.unstubAllEnvs();
    });
    mocks.requireImportUser.mockReset().mockResolvedValue({ id: "user-id" });
  });

  it("enforces the strict per-user hourly limit before processing", async () => {
    const response = await POST(uploadRequest());

    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "import-upload-user",
      "user-id",
      5,
      60 * 60_000,
    );
    expect(response.status).toBe(200);
  });

  it("invalidates owner map data after automatic rows are committed", async () => {
    mocks.createUpload.mockResolvedValue({
      batchId: "batch-id",
      status: "review",
      reused: false,
      completion: {
        totalRows: 2,
        importedRows: 1,
        duplicateRows: 0,
        skippedRows: 0,
        invalidRows: 1,
        reviewRequiredRows: 1,
      },
    });

    const response = await POST(uploadRequest());

    expect(response.status).toBe(200);
    expect(mocks.revalidateOwnerFlightViews).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized request before parsing or persistence", async () => {
    const response = await POST(uploadRequest(1048576 + 128 * 1024 + 1));

    expect(response.status).toBe(413);
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("normalizes one explicit mapping for the authenticated owner's upload", async () => {
    const response = await POST(
      uploadRequest(undefined, {
        version: 1,
        columns: {
          date: " Date ",
          origin: "From",
          destination: "To",
        },
        defaults: { kind: "private", role: "pilot" },
        dateFormat: "iso",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createUpload).toHaveBeenCalledWith(
      "user-id",
      expect.any(File),
      {
        version: 1,
        columns: { date: "Date", origin: "From", destination: "To" },
        defaults: { kind: "private", role: "pilot" },
        dateFormat: "iso",
      },
    );
  });

  it("rejects an invalid mapping before import persistence", async () => {
    const response = await POST(
      uploadRequest(undefined, {
        columns: { date: "Date", origin: "From", destination: "To" },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });
});
