import { describe, expect, it } from "vitest";
import {
  RESUMABLE_IMPORT_BATCH_STATUSES,
  RETRYABLE_IMPORT_FAILURE_CODES,
  describeResumableImportAction,
  isRetryableImportFailureCode,
  resumableImportAction,
} from "./resume";
import type { ImportBatchStatus } from "./types";

const FINISHED_STATUSES: ImportBatchStatus[] = [
  "committed",
  "deduplicated",
  "cancelled",
  "quarantined",
  "expired",
];

describe("resumableImportAction", () => {
  it("treats a review batch as work the user still owes a decision on", () => {
    expect(resumableImportAction({ status: "review" })).toBe("review");
  });

  it("treats every in-flight status as resumable", () => {
    for (const status of RESUMABLE_IMPORT_BATCH_STATUSES) {
      if (status === "review") continue;
      expect(resumableImportAction({ status })).toBe("in-progress");
    }
  });

  it("never resumes a finished, deduplicated, cancelled, quarantined, or expired batch", () => {
    for (const status of FINISHED_STATUSES) {
      expect(resumableImportAction({ status })).toBeUndefined();
    }
  });

  it("offers a retry only for the failure codes the retry button accepts", () => {
    for (const code of RETRYABLE_IMPORT_FAILURE_CODES) {
      expect(
        resumableImportAction({
          status: "failed",
          error: { code, message: "The import failed." },
        }),
      ).toBe("retry");
    }
  });

  it("hides a failure the retry path cannot recover from", () => {
    // A banner offering to resume a batch whose retry button never renders is
    // a dead end, so both surfaces read the one allowlist.
    expect(
      resumableImportAction({
        status: "failed",
        error: { code: "malware-detected", message: "Malware detected." },
      }),
    ).toBeUndefined();
    expect(resumableImportAction({ status: "failed" })).toBeUndefined();
    expect(isRetryableImportFailureCode(undefined)).toBe(false);
  });
});

describe("describeResumableImportAction", () => {
  it("says what is outstanding in the user's language for every action", () => {
    expect(describeResumableImportAction("review")).toMatch(/review/i);
    expect(describeResumableImportAction("in-progress")).toMatch(
      /did not finish/i,
    );
    expect(describeResumableImportAction("retry")).toMatch(/retried/i);
  });
});
