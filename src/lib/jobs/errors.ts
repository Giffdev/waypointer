export type JobErrorCode =
  | "cancelled"
  | "object-missing"
  | "object-mismatch"
  | "scanner-unavailable"
  | "scanner-timeout"
  | "scanner-signatures-stale"
  | "malware-detected"
  | "invalid-upload"
  | "processing-failed"
  | "lease-lost";

export class DurableJobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "DurableJobError";
  }
}

export function safeJobMessage(code: JobErrorCode): string {
  if (code === "malware-detected") return "The upload did not pass malware scanning.";
  if (code === "invalid-upload" || code === "object-mismatch") {
    return "The uploaded file did not match the expected CSV.";
  }
  if (code === "cancelled") return "The import was cancelled.";
  return "The import could not be processed safely.";
}
