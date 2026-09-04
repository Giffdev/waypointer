import type { ImportBatchStatus } from "./types";

// A batch in one of these states carries no usable outcome for the bytes it
// was created from: `failed` never produced rows to review, `cancelled` was
// abandoned, and `expired` has been scrubbed. Handing one of these back for a
// re-upload of the same file makes a single bad attempt permanent, because
// the file fingerprint is what identifies the batch. Successful states
// (`review`, `committed`, `deduplicated`, and everything still in flight) stay
// reusable so identical uploads keep returning the original import.
export const NON_REUSABLE_IMPORT_BATCH_STATUSES = [
  "failed",
  "cancelled",
  "expired",
] as const;

// The subset that still occupies the partial unique index on
// (user_id, file_sha256) where status <> 'expired'. Staging the same bytes
// again has to free that slot first; `expired` already released it.
export const SUPERSEDABLE_IMPORT_BATCH_STATUSES = [
  "failed",
  "cancelled",
] as const;

export function isReusableImportBatchStatus(
  status: ImportBatchStatus,
): boolean {
  return !(
    NON_REUSABLE_IMPORT_BATCH_STATUSES as readonly string[]
  ).includes(status);
}
