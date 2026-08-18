import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DurableJobError } from "@/lib/jobs/errors";
import type { ClaimedJob } from "@/lib/jobs/types";
import type { MalwareScanner } from "@/lib/scanner/types";
import type { PrivateObjectStorage } from "@/lib/storage";

const state = vi.hoisted(() => ({
  batch: {} as Record<string, unknown>,
  duplicate: null as null | { id: string },
  updates: [] as Array<Record<string, unknown>>,
  stage: vi.fn(),
  stageMapped: vi.fn(),
  automaticallyCommit: vi.fn(),
  scrub: vi.fn(),
  expire: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  withUserDb: async (
    _userId: string,
    operation: (tx: unknown) => unknown,
  ) => operation(transaction()),
}));

vi.mock("@/lib/db/repositories/drizzle-import-repository", () => ({
  DrizzleImportRepository: class DrizzleImportRepository {
    scrubBatchRawSnapshots = state.scrub;
    expireBatchAndScrub = state.expire;
  },
}));

vi.mock("./worker", () => ({
  stageExistingFlightImport: state.stage,
  stageExistingMappedFlightImport: state.stageMapped,
}));
vi.mock("./service", () => ({
  automaticallyCommitImport: state.automaticallyCommit,
}));

import { DurableImportWorker } from "./durable-worker";

const userId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";
const originalHash = "a".repeat(64);
const originalKey = `imports/${userId}/${batchId}/${originalHash}.csv`;
const cleanBytes = Buffer.from(
  "Date,AircraftID,From,To\n2026-02-03,SYNTH,KAAA,KBBB\n",
);

function transaction() {
  return {
    select(selection?: unknown) {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return selection ? (state.duplicate ? [state.duplicate] : []) : [state.batch];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              state.updates.push(values);
              Object.assign(state.batch, values);
              return [];
            },
          };
        },
      };
    },
  };
}

function claimedJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: jobId,
    userId,
    jobType: "scan_import",
    payload: { batchId },
    attempts: 1,
    maxAttempts: 5,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 120_000),
    ...overrides,
  };
}

function jobs(
  overrides: Record<string, unknown> = {},
  job: ClaimedJob = claimedJob(),
) {
  return {
    claim: vi.fn().mockResolvedValue(job),
    renew: vi.fn().mockResolvedValue(true),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue("queued"),
    cancel: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function storage(overrides: Partial<PrivateObjectStorage> = {}) {
  return {
    put: vi.fn(),
    get: vi.fn().mockResolvedValue({ key: originalKey, bytes: cleanBytes }),
    head: vi.fn(),
    presignPut: vi.fn(),
    move: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PrivateObjectStorage;
}

function scanner(
  result: Awaited<ReturnType<MalwareScanner["scan"]>> = {
    verdict: "clean",
    provider: "clamav",
  },
) {
  return {
    assertHealthy: vi.fn(),
    scan: vi.fn().mockResolvedValue(result),
  } satisfies MalwareScanner;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("IMPORT_MAX_BYTES", String(10 * 1024 * 1024));
  state.batch = {
    id: batchId,
    userId,
    status: "queued",
    quarantineObjectKey: null,
    originalObjectKey: originalKey,
    scanAttempts: 0,
    fileSizeBytes: cleanBytes.length,
    originalFileName: "synthetic.csv",
    declaredContentType: "text/csv",
    cancelRequestedAt: null,
  };
  state.duplicate = null;
  state.updates = [];
  state.stage.mockResolvedValue({ batchId, status: "review", reused: false });
  state.stageMapped.mockResolvedValue({
    batchId,
    status: "review",
    reused: false,
  });
  state.automaticallyCommit.mockResolvedValue({
    batchId,
    status: "committed",
    reused: false,
  });
  state.scrub.mockResolvedValue(undefined);
  state.expire.mockResolvedValue(undefined);
});

describe("durable import worker boundaries", () => {
  it("scans clean bytes before moving and staging the canonical object", async () => {
    const queue = jobs();
    const objects = storage();
    const malware = scanner();
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      malware,
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    const canonicalHash = createHash("sha256").update(cleanBytes).digest("hex");
    expect(malware.scan).toHaveBeenCalledWith(cleanBytes);
    expect(objects.move).toHaveBeenCalledWith(
      originalKey,
      `imports/${userId}/${batchId}/${canonicalHash}.csv`,
    );
    expect(state.stage).toHaveBeenCalledOnce();
    expect(state.automaticallyCommit).toHaveBeenCalledWith(
      userId,
      { batchId, status: "review", reused: false },
      expect.any(Object),
      expect.any(Object),
    );
    expect(queue.complete).toHaveBeenCalledWith(jobId, "worker-1");
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "scanning", scanStatus: "scanning" }),
        expect.objectContaining({
          status: "processing",
          scanStatus: "clean",
          scanProvider: "clamav",
        }),
      ]),
    );
  });

  it("revalidates and stages the immutable per-job mapping after a clean scan", async () => {
    const mapping = {
      version: 1,
      columns: { date: "date", origin: "from", destination: "to" },
      defaults: { kind: "private", role: "pilot" },
      dateFormat: "iso",
    };
    const job = claimedJob({ payload: { batchId, mapping } });
    const queue = jobs({}, job);
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      storage(),
      scanner(),
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    expect(state.stageMapped).toHaveBeenCalledWith(
      userId,
      batchId,
      expect.objectContaining({ content: cleanBytes.toString("utf8") }),
      mapping,
      expect.any(Object),
      expect.any(Object),
    );
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.automaticallyCommit).toHaveBeenCalledWith(
      userId,
      { batchId, status: "review", reused: false },
      expect.any(Object),
      expect.any(Object),
    );
    expect(queue.complete).toHaveBeenCalledWith(jobId, "worker-1");
  });

  it("quarantines EICAR without parsing or staging it", async () => {
    const queue = jobs();
    const objects = storage();
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner({ verdict: "infected", provider: "clamav" }),
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    expect(objects.move).toHaveBeenCalledWith(
      originalKey,
      originalKey.replace(/^imports\//, "quarantine/"),
    );
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.automaticallyCommit).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "quarantined",
        scanStatus: "infected",
        failureCode: "malware-detected",
      }),
    );
    expect(queue.complete).toHaveBeenCalledOnce();
  });

  it("quarantines scanner failures and schedules a safe retry", async () => {
    const queue = jobs();
    const objects = storage();
    const malware = scanner();
    vi.mocked(malware.scan).mockRejectedValue(
      new DurableJobError(
        "scanner-unavailable",
        true,
        "Malware scanner is unavailable.",
      ),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      malware,
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    expect(objects.move).toHaveBeenCalledWith(
      originalKey,
      originalKey.replace(/^imports\//, "quarantine/"),
    );
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobId }),
      "scanner-unavailable",
      "The import could not be processed safely.",
      true,
    );
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "retrying",
        scanStatus: "failed",
        failureCode: "scanner-unavailable",
        failureMessage: "The import could not be processed safely.",
      }),
    );
    const scheduledJob = vi.mocked(queue.fail).mock.calls[0][0] as ClaimedJob;
    const retryUpdate = state.updates.find(
      (update) => update.status === "retrying",
    );
    expect(scheduledJob.scheduledRetryAt).toBeInstanceOf(Date);
    expect(retryUpdate?.nextRetryAt).toBe(scheduledJob.scheduledRetryAt);
    expect(consoleError).toHaveBeenCalledWith("durable-import-job-failed", {
      jobId,
      code: "scanner-unavailable",
      attempt: 1,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(originalKey);
  });

  it("honors cancellation before reading or scanning the object", async () => {
    const queue = jobs({
      isCancellationRequested: vi.fn().mockResolvedValue(true),
    });
    const objects = storage();
    const malware = scanner();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      malware,
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    expect(objects.delete).toHaveBeenCalledWith(originalKey);
    expect(objects.get).not.toHaveBeenCalled();
    expect(malware.scan).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "cancelled",
        originalDeletedAt: expect.any(Date),
      }),
    );
    expect(queue.cancel).toHaveBeenCalledWith(jobId, "worker-1");
  });

  it("recovers a parser or staging crash through the bounded retry path", async () => {
    const queue = jobs();
    const objects = storage();
    state.stage.mockRejectedValue(new Error("synthetic parser crash"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await expect(worker.runOne()).resolves.toBe(true);

    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobId }),
      "processing-failed",
      "The import could not be processed safely.",
      true,
    );
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "retrying",
        failureCode: "processing-failed",
        failureMessage: "The import could not be processed safely.",
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "synthetic parser crash",
    );
  });

  it("does not claim object cleanup when cancellation deletion fails", async () => {
    const queue = jobs({
      isCancellationRequested: vi.fn().mockResolvedValue(true),
    });
    const objects = storage({
      delete: vi.fn().mockRejectedValue(new Error("synthetic delete failure")),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "cancelled",
        originalDeletedAt: null,
      }),
    );
  });

  it("does not claim duplicate object cleanup when deletion fails", async () => {
    state.duplicate = {
      id: "00000000-0000-4000-8000-000000000099",
    };
    const queue = jobs();
    const objects = storage({
      delete: vi.fn().mockRejectedValue(new Error("synthetic delete failure")),
    });
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(state.stage).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "deduplicated",
        originalDeletedAt: null,
      }),
    );
  });

  it("cleans an expired unfinalized upload before recording deletion", async () => {
    state.batch = {
      ...state.batch,
      status: "pending",
      uploadExpiresAt: new Date(Date.now() - 60_000),
      originalDeletedAt: null,
    };
    const cleanupJob = claimedJob({
      jobType: "cleanup_import_upload",
      payload: { batchId },
    });
    const queue = jobs({}, cleanupJob);
    const objects = storage();
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(objects.delete).toHaveBeenCalledWith(originalKey);
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        status: "expired",
        originalDeletedAt: expect.any(Date),
      }),
    );
    expect(queue.complete).toHaveBeenCalledWith(jobId, "worker-1");
  });

  it("retries expired-upload cleanup without a false deletion timestamp", async () => {
    state.batch = {
      ...state.batch,
      status: "pending",
      uploadExpiresAt: new Date(Date.now() - 60_000),
      originalDeletedAt: null,
    };
    const cleanupJob = claimedJob({
      jobType: "cleanup_import_upload",
      payload: { batchId },
    });
    const queue = jobs({}, cleanupJob);
    const objects = storage({
      delete: vi.fn().mockRejectedValue(new Error("synthetic cleanup crash")),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "cleanup_import_upload" }),
      "processing-failed",
      "The background cleanup could not be completed.",
      true,
    );
    expect(state.updates).not.toContainEqual(
      expect.objectContaining({ originalDeletedAt: expect.any(Date) }),
    );
  });

  it("deletes retained objects before scrubbing snapshots and expiring the batch", async () => {
    state.batch = {
      ...state.batch,
      status: "review",
      expiresAt: new Date(Date.now() - 60_000),
      originalDeletedAt: null,
    };
    const cleanupJob = claimedJob({
      jobType: "cleanup_import_retention",
      payload: { batchId },
    });
    const queue = jobs({}, cleanupJob);
    const objects = storage();
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(objects.delete).toHaveBeenCalledWith(originalKey);
    expect(state.scrub).toHaveBeenCalledWith(userId, batchId);
    expect(state.expire).toHaveBeenCalledWith(userId, batchId);
    expect(
      vi.mocked(objects.delete).mock.invocationCallOrder[0],
    ).toBeLessThan(state.scrub.mock.invocationCallOrder[0]);
    expect(state.scrub.mock.invocationCallOrder[0]).toBeLessThan(
      state.expire.mock.invocationCallOrder[0],
    );
  });

  it("does not scrub retained snapshots when object cleanup crashes", async () => {
    state.batch = {
      ...state.batch,
      status: "review",
      expiresAt: new Date(Date.now() - 60_000),
      originalDeletedAt: null,
    };
    const cleanupJob = claimedJob({
      jobType: "cleanup_import_retention",
      payload: { batchId },
    });
    const queue = jobs({}, cleanupJob);
    const objects = storage({
      delete: vi.fn().mockRejectedValue(new Error("synthetic cleanup crash")),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new DurableImportWorker(
      queue as never,
      queue as never,
      objects,
      scanner(),
      "worker-1",
      120,
    );

    await worker.runOne();

    expect(state.scrub).not.toHaveBeenCalled();
    expect(state.expire).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "cleanup_import_retention" }),
      "processing-failed",
      "The background cleanup could not be completed.",
      true,
    );
  });
});
