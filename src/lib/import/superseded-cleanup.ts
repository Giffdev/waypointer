import type { SupersededImportBatch } from "@/lib/db/repositories/import-repository";

type ObjectStorage = {
  delete(key: string): Promise<void>;
};

type CleanupRecorder = {
  recordBatchObjectCleanup(userId: string, batchId: string): Promise<void>;
};

export type SupersededObjectCleanupResult = {
  deletedKeys: string[];
  failedBatchIds: string[];
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Deletes the private uploads of superseded batches and records the outcome.
 *
 * A batch is only stamped as cleaned once every key it owns is gone, so a
 * failed delete leaves the batch discoverable and the next retention sweep
 * retries it. Keys in `retainedKeys` belong to a live batch that took the
 * object over: they are not deleted, but they do count as handled, otherwise a
 * later sweep would delete an object that is still in use.
 */
export async function cleanUpSupersededObjects(
  userId: string,
  superseded: readonly SupersededImportBatch[],
  storage: ObjectStorage,
  repository: CleanupRecorder,
  retainedKeys: ReadonlySet<string> = new Set(),
): Promise<SupersededObjectCleanupResult> {
  const deletedKeys: string[] = [];
  const failedBatchIds: string[] = [];
  for (const batch of superseded) {
    let deletedEverything = true;
    for (const key of batch.pendingObjectKeys) {
      if (retainedKeys.has(key)) continue;
      try {
        await storage.delete(key);
        deletedKeys.push(key);
      } catch (error) {
        deletedEverything = false;
        // Object keys and failure messages are not logged: the key embeds the
        // owner and the message can quote provider payloads.
        console.warn("import-superseded-object-delete-failed", {
          batchId: batch.batchId,
          error: errorName(error),
        });
      }
    }
    if (deletedEverything) {
      try {
        await repository.recordBatchObjectCleanup(userId, batch.batchId);
      } catch (error) {
        // Cleanup bookkeeping must never fail the request that triggered it:
        // the batch simply stays pending for the next sweep.
        console.warn("import-superseded-cleanup-record-failed", {
          batchId: batch.batchId,
          error: errorName(error),
        });
        failedBatchIds.push(batch.batchId);
      }
    } else {
      failedBatchIds.push(batch.batchId);
    }
  }
  return { deletedKeys, failedBatchIds };
}
