import { describe, expect, it, vi } from "vitest";
import { resolveCleanGitSource } from "./create-vercel-provider-expectation";

describe("provider expectation Git pin", () => {
  it("pins a clean GitHub commit and branch", async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0".repeat(40))
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("git@github.com:giffdev/waypointer.git");
    await expect(resolveCleanGitSource(runGit)).resolves.toEqual({
      commitSha: "0".repeat(40),
      ref: "main",
    });
  });

  it("rejects dirty or substituted repositories", async () => {
    const dirty = vi.fn().mockResolvedValue(" M src/app.ts");
    await expect(resolveCleanGitSource(dirty)).rejects.toMatchObject({
      diagnosticCode: "candidate-provenance-mismatch",
    });

    const substituted = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0".repeat(40))
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("https://github.com/attacker/flight-map.git");
    await expect(resolveCleanGitSource(substituted)).rejects.toMatchObject({
      diagnosticCode: "candidate-provenance-mismatch",
    });
  });
});
