import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { withUserDb } from "@/lib/db";
import { backgroundJobs, importBatches } from "@/lib/db/schema";
import { isDurableImportConfiguration } from "@/lib/runtime-mode";
import { getPrivateObjectStorage } from "@/lib/storage";
import { createImportObjectKey } from "@/lib/storage/presign";
import { DurableJobRepository } from "@/lib/jobs/repository";
import { ImportServiceError } from "@/app/api/import/_lib/service";
import {
  canonicalGenericCsvMapping,
  parseGenericCsvMapping,
} from "@/lib/import/generic-mapping";
import type { GenericCsvMapping } from "@/lib/import/generic-csv";

// iOS Safari's Files picker reports "application/vnd.ms-excel" for .csv
// files (Apple maps the .csv extension to the Excel/Numbers UTI instead of
// text/csv) and sometimes omits a content type entirely. The filename
// extension is already validated by cleanCsvName, so this allowlist only
// needs to reject clearly unrelated content types, not every browser/OS
// MIME-sniffing quirk.
const ALLOWED_TYPES = new Set([
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
]);

export type InitiateImportUpload = {
  batchId: string;
  uploadUrl: string;
  expiresAt: string;
  headers: Record<string, string>;
};

export function assertDurableImportsEnabled(): void {
  if (!isDurableImportConfiguration()) {
    throw new ImportServiceError(
      503,
      "feature-unavailable",
      "Durable imports are temporarily unavailable.",
    );
  }
}

export async function initiateDurableImport(
  userId: string,
  input: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    idempotencyKey?: string;
  },
): Promise<InitiateImportUpload> {
  assertDurableImportsEnabled();
  const fileName = cleanCsvName(input.fileName);
  // Mirror the client's own fallback (selectedFile.type || "text/csv") so a
  // blank content type reported by a browser's file picker is treated as a
  // CSV rather than rejected.
  const contentType = (input.contentType.trim() || "text/csv").toLowerCase();
  const maxBytes = configuredMaxBytes();
  if (!ALLOWED_TYPES.has(contentType)) {
    throw new ImportServiceError(
      415,
      "unsupported-content-type",
      "The upload must use a supported CSV content type.",
    );
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > maxBytes
  ) {
    throw new ImportServiceError(
      input.sizeBytes > maxBytes ? 413 : 400,
      "invalid-file-size",
      "The upload size is invalid.",
    );
  }
  if (
    input.idempotencyKey &&
    !/^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey)
  ) {
    throw new ImportServiceError(
      400,
      "invalid-idempotency-key",
      "The upload request identifier is invalid.",
    );
  }

  const batchId = randomUUID();
  const objectKey = createImportObjectKey(userId, batchId);
  const placeholderHash = randomBytes(32).toString("hex");
  const uploadExpiresAt = new Date(Date.now() + 10 * 60_000);
  const expiresAt = new Date(
    Date.now() + configuredRetentionDays() * 24 * 60 * 60_000,
  );
  const created = await withUserDb(userId, async (tx) => {
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, userId),
            eq(importBatches.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.status !== "pending" ||
          !existing.uploadExpiresAt ||
          existing.uploadExpiresAt.getTime() <= Date.now()
        ) {
          throw new ImportServiceError(
            409,
            "upload-conflict",
            "The upload request has already been used.",
          );
        }
        return {
          id: existing.id,
          objectKey: existing.originalObjectKey,
          uploadExpiresAt: existing.uploadExpiresAt,
          reused: true,
        };
      }
    }
    const [batch] = await tx
      .insert(importBatches)
      .values({
        id: batchId,
        userId,
        adapterId: "pending-detection",
        adapterVersion: 0,
        status: "pending",
        originalObjectKey: objectKey,
        originalFileName: fileName,
        declaredContentType: contentType,
        fileSha256: placeholderHash,
        fileSizeBytes: input.sizeBytes,
        idempotencyKey: input.idempotencyKey ?? `upload:${batchId}`,
        uploadExpiresAt,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: importBatches.id });
    if (batch) {
      await tx.insert(backgroundJobs).values({
        userId,
        jobType: "cleanup_import_upload",
        payload: { batchId },
        idempotencyKey: `cleanup-import-upload:${batchId}`,
        availableAt: uploadExpiresAt,
        maxAttempts: 5,
      });
      await tx.insert(backgroundJobs).values({
        userId,
        jobType: "cleanup_import_retention",
        payload: { batchId },
        idempotencyKey: `cleanup-import-retention:${batchId}`,
        availableAt: expiresAt,
        maxAttempts: 5,
      });
    }
    return batch
      ? { id: batch.id, objectKey, uploadExpiresAt, reused: false }
      : null;
  });
  if (!created) {
    throw new ImportServiceError(
      409,
      "upload-conflict",
      "The upload request could not be created.",
    );
  }
  try {
    const signed = await getPrivateObjectStorage().presignPut(
      created.objectKey,
      input.sizeBytes,
      contentType,
      created.reused
        ? Math.max(
            1,
            Math.min(
              10 * 60,
              Math.floor(
                (created.uploadExpiresAt.getTime() - Date.now()) / 1000,
              ),
            ),
          )
        : 10 * 60,
    );
    return {
      batchId: created.id,
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      headers: signed.headers,
    };
  } catch {
    if (!created.reused) {
      await withUserDb(userId, async (tx) => {
        await tx
          .delete(backgroundJobs)
          .where(
            and(
              eq(backgroundJobs.userId, userId),
              inArray(backgroundJobs.idempotencyKey, [
                `cleanup-import-upload:${batchId}`,
                `cleanup-import-retention:${batchId}`,
              ]),
            ),
          );
        await tx
          .delete(importBatches)
          .where(
            and(
              eq(importBatches.id, batchId),
              eq(importBatches.userId, userId),
              eq(importBatches.status, "pending"),
            ),
          );
      });
    }
    throw new ImportServiceError(
      503,
      "storage-unavailable",
      "Private upload storage is temporarily unavailable.",
    );
  }
}

export async function finalizeDurableImport(
  userId: string,
  batchId: string,
  mappingValue?: unknown,
): Promise<{ batchId: string; status: "queued"; reused: boolean }> {
  assertDurableImportsEnabled();
  assertBatchId(batchId);
  let mapping: GenericCsvMapping | undefined;
  if (mappingValue !== undefined) {
    try {
      mapping = parseGenericCsvMapping(
        JSON.parse(canonicalGenericCsvMapping(mappingValue)),
      );
    } catch {
      throw new ImportServiceError(
        400,
        "invalid-mapping",
        "The CSV column mapping is invalid.",
      );
    }
  }
  const [batch] = await withUserDb(userId, (tx) =>
    tx
      .select()
      .from(importBatches)
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)),
      )
      .limit(1),
  );
  if (!batch) {
    throw new ImportServiceError(404, "batch-not-found", "Batch not found.");
  }
  if (["queued", "scanning", "processing", "retrying", "review"].includes(batch.status)) {
    return { batchId, status: "queued", reused: true };
  }
  if (batch.status !== "pending" || !batch.uploadExpiresAt) {
    throw new ImportServiceError(
      409,
      "upload-not-finalizable",
      "The upload cannot be finalized.",
    );
  }
  if (batch.uploadExpiresAt.getTime() <= Date.now()) {
    throw new ImportServiceError(
      410,
      "upload-expired",
      "The upload authorization expired.",
    );
  }
  const storage = getPrivateObjectStorage();
  const object = await storage.head(batch.originalObjectKey);
  if (
    !object ||
    object.sizeBytes !== batch.fileSizeBytes ||
    object.contentType.toLowerCase() !== batch.declaredContentType?.toLowerCase()
  ) {
    let originalDeletedAt: Date | null = null;
    if (object) {
      try {
        await storage.delete(batch.originalObjectKey);
        originalDeletedAt = new Date();
      } catch {
        originalDeletedAt = null;
      }
    }
    await withUserDb(userId, (tx) =>
      tx
        .update(importBatches)
        .set({
          status: "failed",
          failureCode: "object-mismatch",
          failureMessage: "The uploaded file did not match the expected CSV.",
          originalDeletedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importBatches.id, batchId),
            eq(importBatches.userId, userId),
            eq(importBatches.status, "pending"),
          ),
        ),
    );
    throw new ImportServiceError(
      422,
      "object-mismatch",
      "The uploaded file did not match the expected CSV.",
    );
  }

  const queued = await withUserDb(userId, async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(importBatches)
      .set({
        status: "queued",
        objectEtag: object.etag ?? null,
        uploadCompletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(importBatches.id, batchId),
          eq(importBatches.userId, userId),
          eq(importBatches.status, "pending"),
        ),
      )
      .returning({ id: importBatches.id });
    if (!updated) return false;
    await tx
      .insert(backgroundJobs)
      .values({
        userId,
        jobType: "scan_import",
        payload: mapping ? { batchId, mapping } : { batchId },
        idempotencyKey: `scan-import:${batchId}`,
      })
      .onConflictDoNothing();
    return true;
  });
  if (!queued) {
    return { batchId, status: "queued", reused: true };
  }
  return { batchId, status: "queued", reused: false };
}

export async function cancelDurableImport(
  userId: string,
  batchId: string,
): Promise<void> {
  assertDurableImportsEnabled();
  assertBatchId(batchId);
  const cancelled = await new DurableJobRepository().requestImportCancellation(
    userId,
    batchId,
  );
  if (!cancelled) {
    throw new ImportServiceError(
      409,
      "batch-not-cancellable",
      "The import cannot be cancelled.",
    );
  }
  const [batch] = await withUserDb(userId, (tx) =>
    tx
      .select({
        status: importBatches.status,
        originalObjectKey: importBatches.originalObjectKey,
        quarantineObjectKey: importBatches.quarantineObjectKey,
      })
      .from(importBatches)
      .where(
        and(eq(importBatches.id, batchId), eq(importBatches.userId, userId)),
      )
      .limit(1),
  );
  if (batch?.status === "cancelled") {
    const storage = getPrivateObjectStorage();
    let deleted = true;
    for (const key of new Set(
      [batch.originalObjectKey, batch.quarantineObjectKey].filter(
        (value): value is string => Boolean(value),
      ),
    )) {
      try {
        await storage.delete(key);
      } catch {
        deleted = false;
      }
    }
    if (deleted) {
      await withUserDb(userId, (tx) =>
        tx
          .update(importBatches)
          .set({ originalDeletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(importBatches.id, batchId),
              eq(importBatches.userId, userId),
              eq(importBatches.status, "cancelled"),
            ),
          ),
      );
    }
  }
}

export async function retryDurableImport(
  userId: string,
  batchId: string,
): Promise<void> {
  assertDurableImportsEnabled();
  assertBatchId(batchId);
  const retried = await new DurableJobRepository().retryImport(userId, batchId);
  if (!retried) {
    throw new ImportServiceError(
      409,
      "batch-not-retryable",
      "The import cannot be retried.",
    );
  }
}

function configuredMaxBytes(): number {
  const value = Number(process.env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 10 * 1024 * 1024) {
    throw new Error("IMPORT_MAX_BYTES must be from 1 KiB to 10 MiB.");
  }
  return value;
}

function configuredRetentionDays(): number {
  const value = Number(process.env.IMPORT_RETENTION_DAYS ?? 7);
  if (!Number.isSafeInteger(value) || value < 1 || value > 30) {
    throw new Error("IMPORT_RETENTION_DAYS must be from 1 to 30.");
  }
  return value;
}

function cleanCsvName(value: string): string {
  const name = value.replace(/^.*[\\/]/, "").trim();
  if (!name.toLowerCase().endsWith(".csv") || name.length > 160) {
    throw new ImportServiceError(400, "invalid-file-name", "Choose a CSV file.");
  }
  return name.replace(/[^\w .()-]+/g, "_");
}

function assertBatchId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new ImportServiceError(400, "invalid-batch-id", "Invalid batch ID.");
  }
}
