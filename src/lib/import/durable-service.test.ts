import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  presignPut: vi.fn(),
  head: vi.fn(),
  deleteObject: vi.fn(),
  deletedBatch: vi.fn(),
  deletedTables: [] as unknown[],
  updates: [] as Array<Record<string, unknown>>,
  batch: null as null | Record<string, unknown>,
  userIds: [] as string[],
  requestCancellation: vi.fn(),
  requestRetry: vi.fn(),
}));

vi.mock("@/lib/runtime-mode", () => ({
  isDurableImportConfiguration: vi.fn(() => true),
}));

vi.mock("@/lib/storage", () => ({
  getPrivateObjectStorage: () => ({
    presignPut: mocks.presignPut,
    head: mocks.head,
    delete: mocks.deleteObject,
  }),
}));

vi.mock("@/lib/jobs/repository", () => ({
  DurableJobRepository: class DurableJobRepository {
    requestImportCancellation = mocks.requestCancellation;
    retryImport = mocks.requestRetry;
  },
}));

vi.mock("@/lib/db", () => ({
  withUserDb: async (
    userId: string,
    operation: (tx: unknown) => unknown,
  ) => {
    mocks.userIds.push(userId);
    return operation(transaction());
  },
}));

function transaction() {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return mocks.batch ? [mocks.batch] : [];
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          mocks.values(value);
          const returning = async () => [{ id: value.id }];
          return {
            onConflictDoNothing() {
              return {
                returning,
                then(resolve: (value: unknown) => void) {
                  resolve(undefined);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(value: Record<string, unknown>) {
          mocks.updates.push(value);
          if (mocks.batch) Object.assign(mocks.batch, value);
          const result = {
            async returning() {
              return [{ id: mocks.batch?.id }];
            },
            then(resolve: (value: unknown) => void) {
              resolve(undefined);
            },
          };
          return {
            where() {
              return result;
            },
          };
        },
      };
    },
    delete(table: unknown) {
      mocks.deletedTables.push(table);
      return {
        where: mocks.deletedBatch,
      };
    },
  };
}

import {
  cancelDurableImport,
  finalizeDurableImport,
  initiateDurableImport,
  retryDurableImport,
} from "./durable-service";
import { backgroundJobs, importBatches } from "@/lib/db/schema";

const userId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";
const objectKey = `imports/${userId}/${batchId}/${"a".repeat(64)}.csv`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("IMPORT_MAX_BYTES", "10485760");
  vi.stubEnv("IMPORT_RETENTION_DAYS", "7");
  mocks.batch = null;
  mocks.updates = [];
  mocks.userIds = [];
  mocks.deletedTables = [];
  mocks.head.mockReset();
  mocks.deleteObject.mockReset().mockResolvedValue(undefined);
  mocks.requestCancellation.mockReset().mockResolvedValue(true);
  mocks.requestRetry.mockReset().mockResolvedValue(true);
  mocks.presignPut.mockResolvedValue({
    url: "https://objects.example.test/signed-upload",
    expiresAt: new Date("2026-08-13T21:00:00.000Z"),
    headers: { "content-type": "text/csv" },
  });
});

describe("durable direct-upload finalization", () => {
  beforeEach(() => {
    mocks.batch = {
      id: batchId,
      userId,
      status: "pending",
      originalObjectKey: objectKey,
      fileSizeBytes: 2048,
      declaredContentType: "text/csv",
      uploadExpiresAt: new Date(Date.now() + 60_000),
    };
  });

  describe("durable cancellation and retry ownership", () => {
    beforeEach(() => {
      mocks.batch = {
        id: batchId,
        userId,
        status: "cancelled",
        originalObjectKey: objectKey,
        quarantineObjectKey: null,
      };
    });

    it("deletes a cancelled owner object before recording cleanup", async () => {
      await expect(cancelDurableImport(userId, batchId)).resolves.toBeUndefined();

      expect(mocks.requestCancellation).toHaveBeenCalledWith(userId, batchId);
      expect(mocks.deleteObject).toHaveBeenCalledWith(objectKey);
      expect(mocks.updates).toContainEqual(
        expect.objectContaining({ originalDeletedAt: expect.any(Date) }),
      );
    });

    it("leaves cleanup unclaimed when cancellation object deletion fails", async () => {
      mocks.deleteObject.mockRejectedValue(
        new Error("synthetic cancellation cleanup failure"),
      );

      await expect(cancelDurableImport(userId, batchId)).resolves.toBeUndefined();

      expect(mocks.updates).not.toContainEqual(
        expect.objectContaining({ originalDeletedAt: expect.any(Date) }),
      );
    });

    it("rejects non-cancellable and non-retryable owner states", async () => {
      mocks.requestCancellation.mockResolvedValue(false);
      await expect(cancelDurableImport(userId, batchId)).rejects.toMatchObject({
        code: "batch-not-cancellable",
        status: 409,
      });

      mocks.requestRetry.mockResolvedValue(false);
      await expect(retryDurableImport(userId, batchId)).rejects.toMatchObject({
        code: "batch-not-retryable",
        status: 409,
      });
      expect(mocks.requestRetry).toHaveBeenCalledWith(userId, batchId);
    });
  });

  it("queues exactly one owner-scoped job after object size and type match", async () => {
    mocks.head.mockResolvedValue({
      key: objectKey,
      sizeBytes: 2048,
      contentType: "text/csv",
      etag: "synthetic-etag",
    });

    await expect(finalizeDurableImport(userId, batchId)).resolves.toEqual({
      batchId,
      status: "queued",
      reused: false,
    });

    expect(mocks.userIds.every((value) => value === userId)).toBe(true);
    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        status: "queued",
        objectEtag: "synthetic-etag",
        uploadCompletedAt: expect.any(Date),
      }),
    );
    expect(mocks.values).toHaveBeenCalledWith({
      userId,
      jobType: "scan_import",
      payload: { batchId },
      idempotencyKey: `scan-import:${batchId}`,
    });
  });

  it("stores only one canonical versioned mapping in the owner job payload", async () => {
    mocks.head.mockResolvedValue({
      key: objectKey,
      sizeBytes: 2048,
      contentType: "text/csv",
      etag: "synthetic-etag",
    });

    await finalizeDurableImport(userId, batchId, {
      version: 1,
      columns: { date: " Date ", origin: "From", destination: "To" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
    });

    expect(mocks.values).toHaveBeenCalledWith({
      userId,
      jobType: "scan_import",
      payload: {
        batchId,
        mapping: {
          version: 1,
          columns: { date: "date", origin: "from", destination: "to" },
          defaults: { kind: "private", role: "pilot" },
          dateFormat: "iso",
        },
      },
      idempotencyKey: `scan-import:${batchId}`,
    });
  });

  it.each([
    [null, false],
    [
      {
        key: objectKey,
        sizeBytes: 2049,
        contentType: "text/csv",
      },
      true,
    ],
    [
      {
        key: objectKey,
        sizeBytes: 2048,
        contentType: "application/pdf",
      },
      true,
    ],
  ])(
    "fails closed on missing or mismatched direct object %#",
    async (head, shouldDelete) => {
      mocks.head.mockResolvedValue(head);

      await expect(finalizeDurableImport(userId, batchId)).rejects.toMatchObject(
        {
          code: "object-mismatch",
          status: 422,
        },
      );

      expect(mocks.deleteObject).toHaveBeenCalledTimes(shouldDelete ? 1 : 0);
      expect(mocks.updates).toContainEqual(
        expect.objectContaining({
          status: "failed",
          failureCode: "object-mismatch",
          failureMessage: "The uploaded file did not match the expected CSV.",
        }),
      );
      expect(mocks.values).not.toHaveBeenCalled();
    },
  );

  it("does not claim mismatched object cleanup when deletion fails", async () => {
    mocks.head.mockResolvedValue({
      key: objectKey,
      sizeBytes: 2049,
      contentType: "text/csv",
    });
    mocks.deleteObject.mockRejectedValue(
      new Error("synthetic object deletion failure"),
    );

    await expect(finalizeDurableImport(userId, batchId)).rejects.toMatchObject({
      code: "object-mismatch",
      status: 422,
    });

    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        originalDeletedAt: null,
      }),
    );
  });

  it("is idempotent after another finalizer already queued the batch", async () => {
    mocks.batch.status = "queued";

    await expect(finalizeDurableImport(userId, batchId)).resolves.toEqual({
      batchId,
      status: "queued",
      reused: true,
    });

    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
    expect(mocks.values).not.toHaveBeenCalled();
  });
});

describe("durable direct-upload initiation", () => {
  it("binds the signed key, declared size, and CSV type to the owner batch", async () => {
    const response = await initiateDurableImport(userId, {
      fileName: "..\\synthetic flights.csv",
      contentType: "text/csv",
      sizeBytes: 5120,
      idempotencyKey: "browser-upload-0001",
    });

    const persisted = mocks.values.mock.calls[0][0];
    expect(persisted).toEqual(
      expect.objectContaining({
        userId,
        originalFileName: "synthetic flights.csv",
        declaredContentType: "text/csv",
        fileSizeBytes: 5120,
        idempotencyKey: "browser-upload-0001",
        status: "pending",
      }),
    );
    expect(persisted.originalObjectKey).toMatch(
      new RegExp(
        `^imports/${userId}/${response.batchId}/[0-9a-f]{64}\\.csv$`,
      ),
    );
    expect(mocks.presignPut).toHaveBeenCalledWith(
      persisted.originalObjectKey,
      5120,
      "text/csv",
      600,
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        jobType: "cleanup_import_upload",
        payload: { batchId: response.batchId },
        idempotencyKey: `cleanup-import-upload:${response.batchId}`,
        availableAt: expect.any(Date),
      }),
    );
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        jobType: "cleanup_import_retention",
        payload: { batchId: response.batchId },
        idempotencyKey: `cleanup-import-retention:${response.batchId}`,
        availableAt: expect.any(Date),
      }),
    );
    expect(response).toEqual({
      batchId: persisted.id,
      uploadUrl: "https://objects.example.test/signed-upload",
      expiresAt: "2026-08-13T21:00:00.000Z",
      headers: { "content-type": "text/csv" },
    });
  });

  it.each([
    ["application/pdf", 1024, "unsupported-content-type", 415],
    ["text/csv", 0, "invalid-file-size", 400],
    ["text/csv", 10485761, "invalid-file-size", 413],
  ])(
    "rejects unsafe declaration type=%s size=%d before persistence",
    async (contentType, sizeBytes, code, status) => {
      const error = await initiateDurableImport(userId, {
        fileName: "synthetic.csv",
        contentType,
        sizeBytes,
      }).catch((caught) => caught);

      expect(error).toMatchObject({ code, status });
      expect(mocks.values).not.toHaveBeenCalled();
      expect(mocks.presignPut).not.toHaveBeenCalled();
    },
  );

  it.each([
    // iOS Safari's Files picker commonly reports this MIME type for .csv
    // files instead of "text/csv"; regression coverage for the mobile
    // upload bug where such files were rejected as unsupported.
    ["application/vnd.ms-excel", "application/vnd.ms-excel"],
    ["APPLICATION/VND.MS-EXCEL", "application/vnd.ms-excel"],
    // Some mobile browsers omit a content type entirely; this should be
    // treated the same as a plain CSV rather than rejected.
    ["", "text/csv"],
    ["   ", "text/csv"],
  ])(
    "accepts real-world mobile content-type declaration %s as %s",
    async (declaredContentType, normalizedContentType) => {
      const response = await initiateDurableImport(userId, {
        fileName: "synthetic.csv",
        contentType: declaredContentType,
        sizeBytes: 1024,
      });

      const persisted = mocks.values.mock.calls[0][0];
      expect(persisted).toEqual(
        expect.objectContaining({
          declaredContentType: normalizedContentType,
        }),
      );
      expect(mocks.presignPut).toHaveBeenCalledWith(
        persisted.originalObjectKey,
        1024,
        normalizedContentType,
        expect.any(Number),
      );
      expect(response.batchId).toBe(persisted.id);
    },
  );

  it("rejects unsafe names and idempotency keys before object authorization", async () => {
    await expect(
      initiateDurableImport(userId, {
        fileName: "synthetic.exe",
        contentType: "text/csv",
        sizeBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "invalid-file-name", status: 400 });
    await expect(
      initiateDurableImport(userId, {
        fileName: "synthetic.csv",
        contentType: "text/csv",
        sizeBytes: 1024,
        idempotencyKey: "../../owner",
      }),
    ).rejects.toMatchObject({ code: "invalid-idempotency-key", status: 400 });
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it("removes the pending batch when signing storage is unavailable", async () => {
    mocks.presignPut.mockRejectedValue(new Error("synthetic storage outage"));

    await expect(
      initiateDurableImport(userId, {
        fileName: "synthetic.csv",
        contentType: "text/plain",
        sizeBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "storage-unavailable", status: 503 });

    expect(mocks.deletedTables).toEqual(
      expect.arrayContaining([backgroundJobs, importBatches]),
    );
  });

  it("reuses one still-valid pending authorization for an idempotency key", async () => {
    mocks.batch = {
      id: batchId,
      userId,
      status: "pending",
      originalObjectKey: objectKey,
      uploadExpiresAt: new Date(Date.now() + 120_000),
      idempotencyKey: "browser-upload-0001",
    };

    await expect(
      initiateDurableImport(userId, {
        fileName: "synthetic.csv",
        contentType: "text/csv",
        sizeBytes: 1024,
        idempotencyKey: "browser-upload-0001",
      }),
    ).resolves.toMatchObject({ batchId });

    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.presignPut).toHaveBeenCalledWith(
      objectKey,
      1024,
      "text/csv",
      expect.any(Number),
    );
  });
});
