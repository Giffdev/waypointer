import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireImportUser: vi.fn(),
  getPendingImportAttention: vi.fn(),
  listBatchesPendingObjectCleanup: vi.fn(),
  scrubBatchRawSnapshots: vi.fn(),
  expireBatchAndScrub: vi.fn(),
  recordBatchObjectCleanup: vi.fn(),
  storageDelete: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
  requireImportUser: mocks.requireImportUser,
}));

vi.mock("../_lib/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../_lib/service")>();
  return {
    ...original,
    importService: {
      ...original.importService,
      getPendingImportAttention: mocks.getPendingImportAttention,
    },
  };
});

import { GET } from "./route";

const attention = {
  reviewBatches: 1,
  pendingRows: 3,
  unresolvedDuplicateRows: 2,
  unresolvedRouteTokenRows: 1,
  adoptedFlightRows: 0,
  reprocessAvailableBatches: 0,
  href: "/import",
};

describe("GET /api/import/attention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireImportUser.mockResolvedValue({ id: "user-1" });
    mocks.getPendingImportAttention.mockResolvedValue(attention);
  });

  it("requires an authenticated import user", async () => {
    const { AuthenticationRequiredError } = await import("@/lib/auth/guards");
    mocks.requireImportUser.mockRejectedValue(
      new AuthenticationRequiredError(),
    );

    const response = await GET();

    expect(response.status).toBe(401);
    // Authentication is checked before the aggregate is read, so an anonymous
    // caller cannot learn anything about anybody's import state.
    expect(mocks.getPendingImportAttention).not.toHaveBeenCalled();
  });

  it("returns the caller's own counts", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(attention);
    expect(mocks.getPendingImportAttention).toHaveBeenCalledWith("user-1");
  });
});
