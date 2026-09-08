import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attention aggregate is a *read*.
 *
 * Every surface that shows an import badge polls it. Riding the retention
 * sweep on that read turned a page render into destructive work — private
 * objects deleted, batches expired, raw snapshots scrubbed — on the request
 * path, repeated on every poll. This file exercises the real service module
 * (no service mock, deliberately: mocking it would assert nothing) and pins
 * the read as side-effect free.
 */

const mocks = vi.hoisted(() => ({
  listBatchesPendingObjectCleanup: vi.fn(),
  scrubBatchRawSnapshots: vi.fn(),
  expireBatchAndScrub: vi.fn(),
  recordBatchObjectCleanup: vi.fn(),
  storageDelete: vi.fn(),
  getPendingImportAttention: vi.fn(),
  findLatestActionableBatch: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  getPrivateObjectStorage: () => ({ delete: mocks.storageDelete }),
}));

vi.mock("@/lib/db/repositories/drizzle-import-repository", () => ({
  DrizzleImportRepository: class {
    listBatchesPendingObjectCleanup = mocks.listBatchesPendingObjectCleanup;
    scrubBatchRawSnapshots = mocks.scrubBatchRawSnapshots;
    expireBatchAndScrub = mocks.expireBatchAndScrub;
    recordBatchObjectCleanup = mocks.recordBatchObjectCleanup;
    getPendingImportAttention = mocks.getPendingImportAttention;
    findLatestActionableBatch = mocks.findLatestActionableBatch;
  },
}));

import { importService } from "./service";

const attention = {
  reviewBatches: 1,
  pendingRows: 3,
  unresolvedDuplicateRows: 2,
  unresolvedRouteTokenRows: 1,
  adoptedFlightRows: 0,
  reprocessAvailableBatches: 0,
  href: "/import",
};

const userId = "3f7a1c02-3f5c-4a5f-9a1b-2b9f0c7d1e44";

describe("importService.getPendingImportAttention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPendingImportAttention.mockResolvedValue(attention);
    // A batch a retention sweep *would* act on, if one ran.
    mocks.listBatchesPendingObjectCleanup.mockResolvedValue([
      {
        batchId: "batch-1",
        status: "committed",
        objectKeys: ["imports/u/b/hash.csv"],
      },
    ]);
  });

  it("returns the counts", async () => {
    await expect(
      importService.getPendingImportAttention(userId),
    ).resolves.toEqual(attention);
    expect(mocks.getPendingImportAttention).toHaveBeenCalledWith(userId);
  });

  it("deletes nothing, expires nothing, and scrubs nothing", async () => {
    await importService.getPendingImportAttention(userId);

    expect(mocks.listBatchesPendingObjectCleanup).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.scrubBatchRawSnapshots).not.toHaveBeenCalled();
    expect(mocks.expireBatchAndScrub).not.toHaveBeenCalled();
    expect(mocks.recordBatchObjectCleanup).not.toHaveBeenCalled();
  });
});

/**
 * Opening /import is the write-adjacent entry point that has always carried
 * the retention sweep, back when it read the whole batch list. Narrowing that
 * read to one bounded row must not quietly take retention with it: an account
 * that only ever visits /import would stop expiring its own uploads.
 */
describe("importService.findLatestActionableBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findLatestActionableBatch.mockResolvedValue(null);
    mocks.listBatchesPendingObjectCleanup.mockResolvedValue([
      {
        batchId: "batch-1",
        status: "committed",
        objectKeys: ["imports/u/b/hash.csv"],
      },
    ]);
    mocks.storageDelete.mockResolvedValue(undefined);
  });

  it("still expires, scrubs, and deletes retained originals past their window", async () => {
    await expect(
      importService.findLatestActionableBatch(userId),
    ).resolves.toBeNull();

    expect(mocks.listBatchesPendingObjectCleanup).toHaveBeenCalledWith(userId);
    expect(mocks.scrubBatchRawSnapshots).toHaveBeenCalledWith(
      userId,
      "batch-1",
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith("imports/u/b/hash.csv");
    expect(mocks.expireBatchAndScrub).toHaveBeenCalledWith(userId, "batch-1");
    expect(mocks.recordBatchObjectCleanup).toHaveBeenCalledWith(
      userId,
      "batch-1",
    );
    expect(mocks.findLatestActionableBatch).toHaveBeenCalledWith(userId);
  });
});
