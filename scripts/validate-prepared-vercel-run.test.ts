import { describe, expect, it } from "vitest";

import { validatePreparedVercelRun } from "./validate-prepared-vercel-run";

const commit = "a".repeat(40);
const validRun = {
  event: "workflow_dispatch",
  path: ".github/workflows/vercel-deploy.yml",
  head_branch: "main",
  head_sha: commit,
  status: "completed",
  conclusion: "success",
};

describe("validate-prepared-vercel-run", () => {
  it("accepts only the completed successful prepare run for the reviewed commit", () => {
    expect(() => validatePreparedVercelRun(validRun, commit)).not.toThrow();
  });

  it.each([
    ["stale SHA", "head_sha", "b".repeat(40)],
    ["wrong workflow path", "path", ".github/workflows/other.yml"],
    ["wrong event", "event", "push"],
    ["wrong branch", "head_branch", "release"],
    ["incomplete status", "status", "in_progress"],
    ["failed conclusion", "conclusion", "failure"],
  ])("rejects a one-field %s mutation", (_name, field, value) => {
    expect(() =>
      validatePreparedVercelRun(
        { ...validRun, [field]: value },
        commit,
      ),
    ).toThrow(/provenance is invalid/i);
  });

  it.each([
    ["event"],
    ["path"],
    ["head_branch"],
    ["head_sha"],
    ["status"],
    ["conclusion"],
  ])("rejects a weakened policy missing %s", (field) => {
    const weakened = { ...validRun } as Record<string, unknown>;
    delete weakened[field];
    expect(() => validatePreparedVercelRun(weakened, commit)).toThrow(
      /provenance is invalid/i,
    );
  });
});
