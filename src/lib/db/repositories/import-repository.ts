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
   * reused (failed/cancelled) so identical bytes can stage again, and returns
   * the private object keys the caller must delete.
   */
  supersedeUnreusableBatches(
    userId: string,
    fingerprint: VersionedFingerprint,
  ): Promise<string[]>;
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
