import type {
  ImportBatchSummary,
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
   */
  supersedeUnreusableBatches(
    userId: string,
    fingerprint: VersionedFingerprint,
  ): Promise<SupersededImportBatch[]>;
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
  getBatch(userId: string, batchId: string): Promise<ImportBatchSummary | null>;
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
