import type {
  ImportBatchSummary,
  PendingImportAttention,
  ImportDecisionAction,
  ImportDuplicateResolution,
  ImportRowsPage,
  StoredImportRow,
  VersionedFingerprint,
} from "@/lib/import/types";

export type CreateImportBatchInput = {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  fileFingerprint: VersionedFingerprint;
  originalObjectKey?: string;
  status: "processing";
};

export type CompleteImportStagingInput = {
  adapterId: string;
  adapterLabel: string;
  adapterVersion: number;
  source: "ForeFlight" | "FlightRadar24" | "CSV";
  rows: StoredImportRow[];
};

/** A batch that gave up its file fingerprint and whose private objects are
 * still awaiting deletion. */
export type SupersededImportBatch = {
  batchId: string;
  pendingObjectKeys: string[];
};

/** A batch whose retention sweep still owes an object deletion. */
export type PendingObjectCleanup = {
  batchId: string;
  status: string;
  objectKeys: string[];
};

/**
 * Upper bound on one cleanup sweep. Sweeps run inline on user requests and
 * accounts predating cleanup tracking can have a long tail of expired
 * batches, so each sweep takes the oldest slice and the rest stays pending
 * for the next one.
 */
export const MAX_OBJECT_CLEANUP_BATCH = 25;

export interface ImportRepository {
  findBatchByFileFingerprint(
    userId: string,
    fingerprint: VersionedFingerprint,
  ): Promise<ImportBatchSummary | null>;
  createBatch(
    userId: string,
    input: CreateImportBatchInput,
  ): Promise<ImportBatchSummary>;
  /**
   * Expires same-fingerprint batches whose lifecycle status can never be
   * reused (failed/cancelled) so identical bytes can stage again.
   *
   * The superseded rows keep their object keys and a null `originalDeletedAt`,
   * so an undeleted upload stays discoverable through
   * `listBatchesPendingObjectCleanup` no matter what the caller does with the
   * returned value. Deleting the returned keys is the fast path, not the only
   * one.
   *
   * `exceptBatchId` protects the batch the caller is currently working on:
   * a batch that already stamped this fingerprint must never supersede itself.
   */
  supersedeUnreusableBatches(
    userId: string,
    fingerprint: VersionedFingerprint,
    exceptBatchId?: string,
  ): Promise<SupersededImportBatch[]>;
  /**
   * The oldest batches past their retention window that have not recorded a
   * successful object cleanup, capped at `MAX_OBJECT_CLEANUP_BATCH`. Anything
   * over the cap stays pending and is returned by the next sweep.
   */
  listBatchesPendingObjectCleanup(
    userId: string,
  ): Promise<PendingObjectCleanup[]>;
  /** Records that every object a batch owned is gone. Only ever called after
   * the deletions are confirmed, so a failure leaves the batch retryable. */
  recordBatchObjectCleanup(userId: string, batchId: string): Promise<void>;
  completeStaging(
    userId: string,
    batchId: string,
    input: CompleteImportStagingInput,
  ): Promise<ImportBatchSummary>;
  failBatch(
    userId: string,
    batchId: string,
    error: { code: string; message: string },
  ): Promise<ImportBatchSummary>;
  scrubBatchRawSnapshots(userId: string, batchId: string): Promise<void>;
  expireBatchAndScrub(userId: string, batchId: string): Promise<void>;
  listBatches(userId: string): Promise<ImportBatchSummary[]>;
  /**
   * One aggregate for every surface that shows an import badge (map, flights,
   * import). Counting attention centrally is what lets the pipeline stop
   * silently auto-redirecting users past rows it could not resolve: the work
   * stays visible instead of being disposed of quietly.
   */
  getPendingImportAttention(userId: string): Promise<PendingImportAttention>;
  getBatch(userId: string, batchId: string): Promise<ImportBatchSummary | null>;
  /**
   * Ids of batches still awaiting review. Narrow by design — see
   * `getReviewBatchState`.
   */
  listReviewBatchIds(userId: string): Promise<string[]>;
  /**
   * Just the status and concurrency stamp of one batch.
   *
   * Reconciliation runs during the airport catalog release, against a database
   * deliberately pinned behind the application's own schema. Reading the whole
   * batch row there means every column the application adds later breaks the
   * release on databases that have not applied it yet.
   */
  getReviewBatchState(
    userId: string,
    batchId: string,
  ): Promise<{ status: string; updatedAt: string } | null>;
  listRows(
    userId: string,
    batchId: string,
    page: number,
    pageSize: number,
  ): Promise<ImportRowsPage | null>;
  getRowsForCommit(
    userId: string,
    batchId: string,
  ): Promise<StoredImportRow[] | null>;
  replaceReviewRows(
    userId: string,
    batchId: string,
    rows: StoredImportRow[],
    expectedBatchUpdatedAt?: string,
  ): Promise<ImportBatchSummary>;
  applyDecisions(
    userId: string,
    batchId: string,
    decisions: Array<{
      rowId: string;
      action: ImportDecisionAction;
      duplicateResolution?: Exclude<ImportDuplicateResolution, "pending">;
    }>,
  ): Promise<ImportBatchSummary>;
}
