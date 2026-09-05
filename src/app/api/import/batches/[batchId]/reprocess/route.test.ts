import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireImportUser: vi.fn(),
  assertSameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  reprocess: vi.fn(),
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
  reprocessDurableImport: mocks.reprocess,
}));

import { POST } from "./route";
import { ImportServiceError } from "@/app/api/import/_lib/service";

const userId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";
const reprocessedBatchId = "00000000-0000-4000-8000-000000000003";

function request(): Request {
  return new Request(
    `https://flight-map.example/api/import/batches/${batchId}/reprocess`,
    { method: "POST", headers: { origin: "https://flight-map.example" } },
  );
}

function params(): { params: Promise<{ batchId: string }> } {
  return { params: Promise.resolve({ batchId }) };
}

/**
 * Reprocess route contract.
 *
 * The route is thin on purpose, and thin routes are exactly where guards get
 * dropped without anything failing. These tests pin the four things the route
 * itself owns — who may call it, from where, how often, and how a service
 * outcome becomes a status — separately from what the service decides.
 */
describe("POST /api/import/batches/[batchId]/reprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireImportUser.mockResolvedValue({ id: userId });
    mocks.assertSameOrigin.mockReturnValue(undefined);
    mocks.consumeRateLimit.mockResolvedValue(undefined);
    mocks.reprocess.mockResolvedValue({
      batchId: reprocessedBatchId,
      reprocessedFromBatchId: batchId,
      status: "queued",
      reused: false,
    });
  });

  it("rejects an anonymous caller before doing any work", async () => {
    const { AuthenticationRequiredError } = await import("@/lib/auth/guards");
    mocks.requireImportUser.mockRejectedValue(
      new AuthenticationRequiredError(),
    );

    const response = await POST(request(), params());

    expect(response.status).toBe(401);
    // Nothing downstream runs: an anonymous request must not copy an object,
    // spend a rate-limit token, or reveal whether the batch exists.
    expect(mocks.assertSameOrigin).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.reprocess).not.toHaveBeenCalled();
  });

  it("enforces same-origin before the rate limit and the service", async () => {
    const { RequestOriginError } = await import("@/lib/auth/request");
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new RequestOriginError();
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden-origin" },
    });
    // A cross-site POST must not burn the victim's reprocess budget.
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.reprocess).not.toHaveBeenCalled();
  });

  it("binds the reprocess to the session owner, never to a routed id", async () => {
    const response = await POST(request(), params());

    expect(response.status).toBe(202);
    // The user id comes from the session, so a caller cannot reprocess
    // somebody else's batch by owning the URL.
    expect(mocks.reprocess).toHaveBeenCalledWith(userId, batchId);
  });

  it("returns 202 when this call created the reprocess", async () => {
    const response = await POST(request(), params());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      batchId: reprocessedBatchId,
      reprocessedFromBatchId: batchId,
      status: "queued",
      reused: false,
    });
  });

  it("returns 200 when the reprocess already existed", async () => {
    // 200 vs 202 is the only way a client can tell "queued again" from
    // "queued now" without guessing, so a double-click reports honestly
    // instead of claiming to have started a second run.
    mocks.reprocess.mockResolvedValue({
      batchId: reprocessedBatchId,
      reprocessedFromBatchId: batchId,
      status: "queued",
      reused: true,
    });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reused: true });
  });

  it("rate limits reprocessing like an upload, because that is its cost", async () => {
    const { RateLimitExceededError } = await import("@/lib/auth/rate-limit");
    mocks.consumeRateLimit.mockRejectedValue(new RateLimitExceededError());

    const response = await POST(request(), params());

    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "import-reprocess-user",
      userId,
      5,
      60 * 60_000,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    // The limit is consumed before the service, so a held-down button cannot
    // multiply stored copies of the user's logbook.
    expect(mocks.reprocess).not.toHaveBeenCalled();
  });

  it.each([
    ["batch-not-found", 404],
    ["reprocess-not-required", 409],
    ["original-file-unavailable", 410],
    ["reprocess-conflict", 409],
  ])("maps the %s service outcome to %i", async (code, status) => {
    mocks.reprocess.mockRejectedValue(
      new ImportServiceError(status, code, "Service said so."),
    );

    const response = await POST(request(), params());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("reports an unexpected failure as 500 with a correlation id, not 503", async () => {
    // 503 tells a client to retry. An unexpected throw here is our defect and
    // will not fix itself, so retrying is the wrong advice.
    mocks.reprocess.mockRejectedValue(new TypeError("boom"));
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await POST(request(), params());

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; correlationId?: string };
    };
    expect(body.error.code).toBe("internal-error");
    expect(body.error.correlationId).toEqual(expect.any(String));
    // The thrown message can quote logbook content, so it must not be logged.
    const [, logged] = errorLog.mock.calls[0] as [string, { stack?: string }];
    expect(JSON.stringify(logged)).not.toContain("boom");
    errorLog.mockRestore();
  });
});
