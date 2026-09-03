import { createHash } from "node:crypto";
import { and, eq, ne, notInArray } from "drizzle-orm";
import { withUserDb } from "@/lib/db";
import { importBatches } from "@/lib/db/schema";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import { DurableJobError, safeJobMessage } from "@/lib/jobs/errors";
import { DurableJobRepository, retryDelayMs } from "@/lib/jobs/repository";
import type { ClaimedJob, ScanImportPayload } from "@/lib/jobs/types";
import { purgeAccountDeletion } from "@/lib/auth/account-deletion";
import type { MalwareScanner } from "@/lib/scanner/types";
import type { PrivateObjectStorage } from "@/lib/storage";
import {
  canonicalImportObjectKey,
  quarantineObjectKey,
} from "@/lib/storage/presign";
import {
  stageExistingFlightImport,
  stageExistingMappedFlightImport,
} from "./worker";
import { parseGenericCsvMapping } from "./generic-mapping";
import { automaticallyCommitImport } from "./service";
import { CsvDecodeError, decodeCsvBytes } from "./csv-decode";
import { NON_REUSABLE_IMPORT_BATCH_STATUSES } from "./batch-lifecycle";
import { cleanUpSupersededObjects } from "./superseded-cleanup";

const repository = new DrizzleImportRepository();

export class DurableImportWorker {
  constructor(
    private readonly jobs: DurableJobRepository,
    private readonly leaseJobs: DurableJobRepository,
    private readonly storage: PrivateObjectStorage,
    private readonly scanner: MalwareScanner,
    private readonly workerId: string,
    private readonly leaseSeconds: number,
  ) {}

  async runOne(): Promise<boolean> {
    const job = await this.jobs.claim(this.workerId, this.leaseSeconds);
    if (!job) return false;
    let leaseLost = false;
    const renewal = setInterval(async () => {
      const renewed = await this.leaseJobs
        .renew(job.id, this.workerId, this.leaseSeconds)
        .catch(() => false);
      if (!renewed) leaseLost = true;
    }, Math.max(10_000, Math.floor((this.leaseSeconds * 1000) / 3)));
    renewal.unref();
    try {
      let completionRequired = true;
      if (job.jobType === "purge_account") {
        const requestId = parseUuidPayload(job.payload, "requestId");
        const result = await purgeAccountDeletion({
          userId: job.userId,
          requestId,
        });
        if (result === "not-ready") {
          throw new DurableJobError(
            "processing-failed",
            true,
            "The account purge is not ready.",
          );
        }
        completionRequired = false;
      } else if (job.jobType === "cleanup_import_upload") {
        await this.cleanupExpiredUpload(
          job.userId,
          parseUuidPayload(job.payload, "batchId"),
        );
      } else if (job.jobType === "cleanup_import_retention") {
        await this.cleanupRetainedImport(
          job.userId,
          parseUuidPayload(job.payload, "batchId"),
        );
      } else {
        await this.processImport(job, () => leaseLost);
      }
      if (
        leaseLost ||
        (completionRequired &&
          !(await this.jobs.complete(job.id, this.workerId)))
      ) {
        throw new DurableJobError("lease-lost", true, "The job lease was lost.");
      }
    } catch (error) {
      const durable =
        error instanceof DurableJobError
          ? error
          : new DurableJobError(
              "processing-failed",
              true,
              "The import worker could not complete the job.",
            );
      await this.failImportJob(job, durable).catch(() => undefined);
      console.error("durable-import-job-failed", {
        jobId: job.id,
        code: durable.code,
        attempt: job.attempts,
      });
    } finally {
      clearInterval(renewal);
    }
    return true;
  }

  private async processImport(
    job: ClaimedJob,
    leaseLost: () => boolean,
  ): Promise<void> {
    const payload = parsePayload(job.payload);
    const batch = await loadBatch(job.userId, payload.batchId);
    if (!batch) {
      throw new DurableJobError(
        "invalid-upload",
        false,
        "The import batch no longer exists.",
      );
    }

    if (["review", "committed", "deduplicated"].includes(batch.status)) return;
    await this.checkpoint(job, payload.batchId, leaseLost);

    const objectKey =
      batch.quarantineObjectKey ?? batch.originalObjectKey;
    await updateBatch(job.userId, payload.batchId, {
      status: "scanning",
      scanStatus: "scanning",
      scanStartedAt: new Date(),
      scanAttempts: batch.scanAttempts + 1,
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    });
    const stored = await this.storage.get(objectKey).catch(() => {
      throw new DurableJobError(
        "object-missing",
        false,
        "The private upload object is unavailable.",
      );
    });
    if (
      stored.bytes.length !== batch.fileSizeBytes ||
      stored.bytes.length > configuredMaxBytes()
    ) {
      throw new DurableJobError(
        "object-mismatch",
        false,
        "The private upload object size changed.",
      );
    }

    let scan;
    try {
      scan = await this.scanner.scan(stored.bytes);
    } catch (error) {
      await this.quarantine(job.userId, payload.batchId, objectKey);
      throw error;
    }
    await this.checkpoint(job, payload.batchId, leaseLost);
    if (scan.verdict === "infected") {
      await this.quarantine(job.userId, payload.batchId, objectKey);
      await updateBatch(job.userId, payload.batchId, {
        status: "quarantined",
        scanStatus: "infected",
        scanProvider: scan.provider,
        scanCompletedAt: new Date(),
        failureCode: "malware-detected",
        failureMessage: safeJobMessage("malware-detected"),
        updatedAt: new Date(),
      });
      return;
    }

    const sha256 = createHash("sha256").update(stored.bytes).digest("hex");
    const duplicate = await findDuplicate(
      job.userId,
      payload.batchId,
      sha256,
    );
    if (duplicate) {
      let originalDeletedAt: Date | null = null;
      try {
        await this.storage.delete(objectKey);
        originalDeletedAt = new Date();
      } catch {
        originalDeletedAt = null;
      }
      await updateBatch(job.userId, payload.batchId, {
        status: "deduplicated",
        duplicateOfBatchId: duplicate.id,
        scanStatus: "clean",
        scanProvider: scan.provider,
        scanCompletedAt: new Date(),
        originalDeletedAt,
        updatedAt: new Date(),
      });
      return;
    }

    const canonicalKey = canonicalImportObjectKey(
      job.userId,
      payload.batchId,
      sha256,
    );
    if (objectKey !== canonicalKey) {
      await this.storage.move(objectKey, canonicalKey);
    }
    // The same bytes may still be claimed by a failed or cancelled attempt;
    // stamping fileSha256 below would collide with the partial unique index
    // on (user_id, file_sha256) while that attempt is not expired. This job's
    // own batch is excluded: a cancelled or retried attempt that already
    // stamped the hash must not expire itself out from under this run. The
    // canonical key is retained rather than deleted: this job now owns it.
    await cleanUpSupersededObjects(
      job.userId,
      await repository.supersedeUnreusableBatches(
        job.userId,
        { algorithm: "sha256", version: 1, value: sha256 },
        payload.batchId,
      ),
      this.storage,
      repository,
      new Set([canonicalKey]),
    );
    await updateBatch(job.userId, payload.batchId, {
      status: "processing",
      originalObjectKey: canonicalKey,
      quarantineObjectKey: null,
      fileSha256: sha256,
      scanStatus: "clean",
      scanProvider: scan.provider,
      scanCompletedAt: new Date(),
      updatedAt: new Date(),
    });
    await this.checkpoint(job, payload.batchId, leaseLost);
    const content = decodeCsv(stored.bytes);
    const upload = {
      fileName: batch.originalFileName,
      mimeType: batch.declaredContentType ?? "text/csv",
      sizeBytes: stored.bytes.length,
      content,
      originalObjectKey: canonicalKey,
    };
    const repositories = {
      imports: repository,
      flights: repository,
      airports: repository,
    };
    const staged = payload.mapping
      ? await stageExistingMappedFlightImport(
        job.userId,
        payload.batchId,
        upload,
        payload.mapping,
        repositories,
        { maxBytes: configuredMaxBytes() },
      )
      : await stageExistingFlightImport(
        job.userId,
        payload.batchId,
        upload,
        repositories,
        { maxBytes: configuredMaxBytes() },
      );
    await automaticallyCommitImport(
      job.userId,
      staged,
      repository,
      repository,
    );
  }

  private async cleanupExpiredUpload(
    userId: string,
    batchId: string,
  ): Promise<void> {
    const batch = await loadBatch(userId, batchId);
    if (
      !batch ||
      !["pending", "cancelled"].includes(batch.status) ||
      batch.originalDeletedAt ||
      !batch.uploadExpiresAt ||
      batch.uploadExpiresAt.getTime() > Date.now()
    ) {
      return;
    }
    const key = batch.quarantineObjectKey ?? batch.originalObjectKey;
    await this.storage.delete(key);
    await updateBatch(userId, batchId, {
      status: batch.status === "pending" ? "expired" : "cancelled",
      originalDeletedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  private async cleanupRetainedImport(
    userId: string,
    batchId: string,
  ): Promise<void> {
    const batch = await loadBatch(userId, batchId);
    if (!batch || batch.expiresAt.getTime() > Date.now()) return;
    if (!batch.originalDeletedAt) {
      for (const key of new Set(
        [batch.originalObjectKey, batch.quarantineObjectKey].filter(
          (value): value is string => Boolean(value),
        ),
      )) {
        await this.storage.delete(key);
      }
    }
    await repository.scrubBatchRawSnapshots(userId, batchId);
    await repository.expireBatchAndScrub(userId, batchId);
    await updateBatch(userId, batchId, {
      originalDeletedAt: batch.originalDeletedAt ?? new Date(),
      updatedAt: new Date(),
    });
  }

  private async checkpoint(
    job: ClaimedJob,
    batchId: string,
    leaseLost: () => boolean,
  ): Promise<void> {
    if (
      leaseLost() ||
      (await this.jobs.isCancellationRequested(job.id, this.workerId))
    ) {
      const batch = await loadBatch(job.userId, batchId);
      const key = batch?.quarantineObjectKey ?? batch?.originalObjectKey;
      let originalDeletedAt: Date | null = null;
      if (key) {
        try {
          await this.storage.delete(key);
          originalDeletedAt = new Date();
        } catch {
          originalDeletedAt = null;
        }
      }
      await updateBatch(job.userId, batchId, {
        status: "cancelled",
        cancelRequestedAt: batch?.cancelRequestedAt ?? new Date(),
        cancelledAt: new Date(),
        originalDeletedAt,
        updatedAt: new Date(),
      });
      throw new DurableJobError("cancelled", false, "The import was cancelled.");
    }
  }

  private async quarantine(
    userId: string,
    batchId: string,
    currentKey: string,
  ): Promise<void> {
    if (currentKey.startsWith("quarantine/")) return;
    const destination = quarantineObjectKey(currentKey);
    await this.storage.move(currentKey, destination);
    await updateBatch(userId, batchId, {
      quarantineObjectKey: destination,
      updatedAt: new Date(),
    });
  }

  private async failImportJob(
    job: ClaimedJob,
    error: DurableJobError,
  ): Promise<void> {
    if (error.code === "cancelled") {
      await this.jobs.cancel(job.id, job.leaseOwner);
      return;
    }
    if (
      job.jobType === "purge_account" ||
      job.jobType === "cleanup_import_upload" ||
      job.jobType === "cleanup_import_retention"
    ) {
      await this.jobs.fail(
        job,
        error.code,
        "The background cleanup could not be completed.",
        error.retryable,
      );
      return;
    }
    const scheduledRetryAt =
      error.retryable && job.attempts < job.maxAttempts
        ? new Date(Date.now() + retryDelayMs(job.attempts))
        : undefined;
    const failedJob = scheduledRetryAt
      ? { ...job, scheduledRetryAt }
      : job;
    const state = await this.jobs.fail(
      failedJob,
      error.code,
      safeJobMessage(error.code),
      error.retryable,
    );
    const payload = parsePayload(job.payload);
    await updateBatch(job.userId, payload.batchId, {
      status: state === "queued" ? "retrying" : "failed",
      scanStatus:
        error.code.startsWith("scanner-") ? "failed" : undefined,
      retryCount: state === "queued" ? job.attempts : undefined,
      nextRetryAt:
        state === "queued" ? scheduledRetryAt : null,
      failureCode: error.code,
      failureMessage: safeJobMessage(error.code),
      updatedAt: new Date(),
    });
  }
}

function parsePayload(value: unknown): ScanImportPayload {
  const batchId = parseUuidPayload(value, "batchId");
  const mappingValue =
    value && typeof value === "object" && "mapping" in value
      ? (value as Record<string, unknown>).mapping
      : undefined;
  if (mappingValue === undefined) return { batchId };
  try {
    return { batchId, mapping: parseGenericCsvMapping(mappingValue) };
  } catch {
    throw new DurableJobError(
      "invalid-upload",
      false,
      "The import job mapping is invalid.",
    );
  }
}

function parseUuidPayload(value: unknown, field: string): string {
  const id =
    value && typeof value === "object" && field in value
      ? String((value as Record<string, unknown>)[field])
      : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new DurableJobError(
      "invalid-upload",
      false,
      "The import job payload is invalid.",
    );
  }
  return id;
}

function loadBatch(userId: string, batchId: string) {
  return withUserDb(userId, async (tx) => {
    const [batch] = await tx
      .select()
      .from(importBatches)
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)),
      )
      .limit(1);
    return batch ?? null;
  });
}

function updateBatch(
  userId: string,
  batchId: string,
  values: Partial<typeof importBatches.$inferInsert>,
) {
  return withUserDb(userId, (tx) =>
    tx
      .update(importBatches)
      .set(values)
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)),
      ),
  );
}

function findDuplicate(userId: string, batchId: string, sha256: string) {
  return withUserDb(userId, async (tx) => {
    const [batch] = await tx
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.userId, userId),
          eq(importBatches.fileSha256, sha256),
          ne(importBatches.id, batchId),
          notInArray(importBatches.status, [
            ...NON_REUSABLE_IMPORT_BATCH_STATUSES,
          ]),
        ),
      )
      .limit(1);
    return batch ?? null;
  });
}

function decodeCsv(bytes: Uint8Array): string {
  try {
    return decodeCsvBytes(bytes).content;
  } catch (error) {
    const message =
      error instanceof CsvDecodeError
        ? error.message
        : "The upload is not valid UTF-8 or Windows-1252 text.";
    throw new DurableJobError("invalid-upload", false, message);
  }
}

function configuredMaxBytes(): number {
  const value = Number(process.env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 10 * 1024 * 1024) {
    throw new Error("IMPORT_MAX_BYTES must be from 1 KiB to 10 MiB.");
  }
  return value;
}
