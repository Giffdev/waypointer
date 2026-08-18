import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireImportUser: vi.fn(),
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  initiate: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
  requireImportUser: mocks.requireImportUser,
}));

vi.mock("@/lib/auth/request", () => ({
  RequestOriginError: class RequestOriginError extends Error {},
  assertSameOrigin: mocks.assertSameOrigin,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  RateLimitExceededError: class RateLimitExceededError extends Error {
    retryAfterSeconds = 60;
  },
  consumeRateLimit: mocks.consumeRateLimit,
}));

vi.mock("@/lib/import/durable-service", () => ({
  initiateDurableImport: mocks.initiate,
  finalizeDurableImport: mocks.finalize,
  cancelDurableImport: mocks.cancel,
  retryDurableImport: mocks.retry,
}));

import { POST as initiatePost } from "./upload/initiate/route";
import { POST as finalizePost } from "./upload/finalize/route";
import { POST as cancelPost } from "./batches/[batchId]/cancel/route";
import { POST as retryPost } from "./batches/[batchId]/retry/route";

const userId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";

function request(path: string, body?: unknown) {
  return new Request(`https://flight-map.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://flight-map.example",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireImportUser.mockResolvedValue({ id: userId });
  mocks.consumeRateLimit.mockResolvedValue(undefined);
  mocks.initiate.mockResolvedValue({
    batchId,
    uploadUrl: "https://objects.example.test/signed",
    expiresAt: "2026-08-13T21:00:00.000Z",
    headers: { "content-type": "text/csv" },
  });
  mocks.finalize.mockResolvedValue({ batchId, status: "queued", reused: false });
  mocks.cancel.mockResolvedValue(undefined);
  mocks.retry.mockResolvedValue(undefined);
});

describe("durable import API ownership", () => {
  it("initiates an owner-bound, rate-limited direct upload", async () => {
    const response = await initiatePost(
      request("/api/import/upload/initiate", {
        fileName: "synthetic.csv",
        contentType: "text/csv",
        sizeBytes: 2048,
        idempotencyKey: "browser-upload-0001",
        userId: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "import-upload-user",
      userId,
      5,
      60 * 60_000,
    );
    expect(mocks.initiate).toHaveBeenCalledWith(userId, {
      fileName: "synthetic.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      idempotencyKey: "browser-upload-0001",
    });
    expect(JSON.stringify(await response.json())).not.toContain(
      "attacker-controlled",
    );
  });

  it("finalizes only the authenticated owner's batch and preserves idempotency status", async () => {
    const response = await finalizePost(
      request("/api/import/upload/finalize", {
        batchId,
        userId: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(202);
    expect(mocks.finalize).toHaveBeenCalledWith(userId, batchId);

    mocks.finalize.mockResolvedValue({ batchId, status: "queued", reused: true });
    const reused = await finalizePost(
      request("/api/import/upload/finalize", { batchId }),
    );
    expect(reused.status).toBe(200);
  });

  it("carries one explicit mapping through the owner-scoped durable finalize seam", async () => {
    const mapping = {
      version: 1,
      columns: { date: "date", origin: "from", destination: "to" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
    };
    const response = await finalizePost(
      request("/api/import/upload/finalize", {
        batchId,
        mapping,
        userId: "attacker-controlled",
      }),
    );

    expect(response.status).toBe(202);
    expect(mocks.finalize).toHaveBeenCalledWith(userId, batchId, mapping);
  });

  it("routes cancellation and retry through owner-scoped service seams", async () => {
    const context = { params: Promise.resolve({ batchId }) };

    await expect(
      cancelPost(request(`/api/import/batches/${batchId}/cancel`), context),
    ).resolves.toMatchObject({ status: 202 });
    await expect(
      retryPost(request(`/api/import/batches/${batchId}/retry`), context),
    ).resolves.toMatchObject({ status: 202 });

    expect(mocks.cancel).toHaveBeenCalledWith(userId, batchId);
    expect(mocks.retry).toHaveBeenCalledWith(userId, batchId);
  });

  it("checks authentication and same-origin before every durable operation", async () => {
    await initiatePost(
      request("/api/import/upload/initiate", {
        fileName: "synthetic.csv",
        contentType: "text/csv",
        sizeBytes: 2048,
      }),
    );
    await finalizePost(
      request("/api/import/upload/finalize", { batchId }),
    );
    await cancelPost(request(`/api/import/batches/${batchId}/cancel`), {
      params: Promise.resolve({ batchId }),
    });
    await retryPost(request(`/api/import/batches/${batchId}/retry`), {
      params: Promise.resolve({ batchId }),
    });

    expect(mocks.requireImportUser).toHaveBeenCalledTimes(4);
    expect(mocks.assertSameOrigin).toHaveBeenCalledTimes(4);
  });
});
