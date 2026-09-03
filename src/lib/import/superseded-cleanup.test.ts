import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanUpSupersededObjects } from "./superseded-cleanup";

function recorder() {
  return { recordBatchObjectCleanup: vi.fn().mockResolvedValue(undefined) };
}

describe("superseded object cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("records the cleanup once every object of the batch is deleted", async () => {
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const repository = recorder();

    const result = await cleanUpSupersededObjects(
      "user-1",
      [
        {
          batchId: "batch-1",
          pendingObjectKeys: ["imports/user-1/batch-1/a.csv", "quarantine/a"],
        },
      ],
      storage,
      repository,
    );

    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(repository.recordBatchObjectCleanup).toHaveBeenCalledWith(
      "user-1",
      "batch-1",
    );
    expect(result).toEqual({
      deletedKeys: ["imports/user-1/batch-1/a.csv", "quarantine/a"],
      failedBatchIds: [],
    });
  });

  it("leaves a failed delete unrecorded so the retention sweep retries it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      delete: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("s3 is unreachable")),
    };
    const repository = recorder();

    const result = await cleanUpSupersededObjects(
      "user-1",
      [
        {
          batchId: "batch-1",
          pendingObjectKeys: ["imports/user-1/batch-1/a.csv", "quarantine/a"],
        },
      ],
      storage,
      repository,
    );

    expect(repository.recordBatchObjectCleanup).not.toHaveBeenCalled();
    expect(result.failedBatchIds).toEqual(["batch-1"]);
    expect(warn).toHaveBeenCalledWith("import-superseded-object-delete-failed", {
      batchId: "batch-1",
      error: "Error",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("imports/user-1");
    expect(logged).not.toContain("s3 is unreachable");
  });

  it("only holds back the batch whose delete failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = {
      delete: vi.fn(async (key: string) => {
        if (key === "broken") throw new Error("gone");
      }),
    };
    const repository = recorder();

    const result = await cleanUpSupersededObjects(
      "user-1",
      [
        { batchId: "batch-1", pendingObjectKeys: ["broken"] },
        { batchId: "batch-2", pendingObjectKeys: ["fine"] },
      ],
      storage,
      repository,
    );

    expect(result.failedBatchIds).toEqual(["batch-1"]);
    expect(repository.recordBatchObjectCleanup).toHaveBeenCalledOnce();
    expect(repository.recordBatchObjectCleanup).toHaveBeenCalledWith(
      "user-1",
      "batch-2",
    );
  });

  it("never deletes an object a live batch took over, and stops sweeping it", async () => {
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const repository = recorder();

    const result = await cleanUpSupersededObjects(
      "user-1",
      [{ batchId: "batch-1", pendingObjectKeys: ["canonical.csv"] }],
      storage,
      repository,
      new Set(["canonical.csv"]),
    );

    expect(storage.delete).not.toHaveBeenCalled();
    expect(result.deletedKeys).toEqual([]);
    expect(repository.recordBatchObjectCleanup).toHaveBeenCalledWith(
      "user-1",
      "batch-1",
    );
  });
});
