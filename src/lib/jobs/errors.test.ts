import { describe, expect, it } from "vitest";
import { DurableJobError, safeJobMessage, type JobErrorCode } from "./errors";

const codes: JobErrorCode[] = [
  "cancelled",
  "object-missing",
  "object-mismatch",
  "scanner-unavailable",
  "scanner-timeout",
  "scanner-signatures-stale",
  "malware-detected",
  "invalid-upload",
  "processing-failed",
  "lease-lost",
];

describe("durable worker error privacy", () => {
  it.each(codes)("maps %s to a bounded user-safe message", (code) => {
    const message = safeJobMessage(code);

    expect(message.length).toBeLessThanOrEqual(80);
    expect(message).not.toMatch(
      /X5O|imports\/|quarantine\/|\.csv|@|token|credential|stack|postgres/i,
    );
  });

  it("preserves retry classification without embedding private context", () => {
    const error = new DurableJobError(
      "scanner-unavailable",
      true,
      safeJobMessage("scanner-unavailable"),
    );

    expect(error).toMatchObject({
      code: "scanner-unavailable",
      retryable: true,
      message: "The import could not be processed safely.",
    });
    expect(JSON.stringify(error)).not.toContain("user");
    expect(JSON.stringify(error)).not.toContain("objectKey");
  });
});
