import type { ImportBatchStatus, ImportBatchSummary } from "./types";

/**
 * Failure codes the import UI has always offered a retry for.
 *
 * Centralized because two surfaces now read it: the retry button on an open
 * batch, and the decision about whether a failed batch is still worth
 * resuming at all. A divergent second list is how a user ends up with a
 * banner offering to resume an import whose retry button never appears.
 */
export const RETRYABLE_IMPORT_FAILURE_CODES = [
  "scanner-unavailable",
  "scanner-timeout",
  "scanner-signatures-stale",
  "processing-failed",
] as const;

export function isRetryableImportFailureCode(code: string | undefined): boolean {
  return (RETRYABLE_IMPORT_FAILURE_CODES as readonly string[]).includes(
    code ?? "",
  );
}

/**
 * Statuses that still owe the user something without any extra qualification:
 * `review` has undecided rows, and the rest are mid-flight and can be polled,
 * cancelled, or retried once selected.
 *
 * `committed`, `deduplicated`, `cancelled`, `quarantined`, and `expired` are
 * deliberately absent: they are finished, and re-surfacing them is the import
 * history this screen no longer shows.
 */
export const RESUMABLE_IMPORT_BATCH_STATUSES = [
  "pending",
  "queued",
  "scanning",
  "processing",
  "retrying",
  "committing",
  "review",
] as const;

export type ResumableImportAction = "review" | "in-progress" | "retry";

export function isResumableImportBatchStatus(
  status: ImportBatchStatus,
): boolean {
  return (RESUMABLE_IMPORT_BATCH_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * What a batch is still waiting on, or `undefined` when it is finished.
 *
 * A failed batch only counts when its failure code is one the retry button
 * accepts; anything else is a dead end and offering to resume it would lie.
 */
export function resumableImportAction(
  batch: Pick<ImportBatchSummary, "status" | "error">,
): ResumableImportAction | undefined {
  if (batch.status === "review") return "review";
  if (isResumableImportBatchStatus(batch.status)) return "in-progress";
  if (batch.status === "failed" && isRetryableImportFailureCode(batch.error?.code)) {
    return "retry";
  }
  return undefined;
}

export function isResumableImportBatch(
  batch: Pick<ImportBatchSummary, "status" | "error">,
): boolean {
  return resumableImportAction(batch) !== undefined;
}

export function describeResumableImportAction(
  action: ResumableImportAction,
): string {
  switch (action) {
    case "review":
      return "Some rows still need your review.";
    case "in-progress":
      return "This import did not finish. You can pick it back up.";
    case "retry":
      return "This import failed and can be retried.";
  }
}
