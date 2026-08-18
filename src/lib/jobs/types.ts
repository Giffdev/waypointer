export type BackgroundJobType =
  | "scan_import"
  | "cleanup_import_upload"
  | "cleanup_import_retention"
  | "purge_account";

export type ScanImportPayload = {
  batchId: string;
  mapping?: GenericCsvMapping;
};

export type PurgeAccountPayload = {
  requestId: string;
};

export type ClaimedJob = {
  id: string;
  userId: string;
  jobType: BackgroundJobType;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  scheduledRetryAt?: Date;
};

export type QueueMetrics = {
  queued: number;
  running: number;
  deadLetter: number;
  oldestQueuedAt: Date | null;
};
import type { GenericCsvMapping } from "@/lib/import/generic-csv";
