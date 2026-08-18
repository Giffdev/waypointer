import { describe, expect, it, vi } from "vitest";
import {
  createProviderReleaseExpectation,
  resolveCleanGitSource,
} from "./create-vercel-provider-expectation";

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

  it("accepts an exact detached commit only when it is on origin/main", async () => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("0".repeat(40))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("https://github.com/Giffdev/waypointer.git");
    await expect(resolveCleanGitSource(runGit)).resolves.toEqual({
      commitSha: "0".repeat(40),
      ref: "main",
    });
    expect(runGit).toHaveBeenCalledWith([
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "origin/main",
    ]);
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

  it("binds a clean commit to an exact reviewed prebuilt artifact", async () => {
    const commitSha = "0".repeat(40);
    const candidateManifestSha256 = "4".repeat(64);
    const prebuiltManifestSha256 = "5".repeat(64);
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(commitSha)
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("https://github.com/Giffdev/waypointer.git");
    const expectation = await createProviderReleaseExpectation(
      {
        NODE_ENV: "test",
        AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH:
          "artifacts/release-evidence/airport-catalog/candidate-test.json",
        AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256:
          candidateManifestSha256,
        FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_PATH:
          "artifacts/release-evidence/vercel-prebuilt-artifact/manifest-test.json",
        FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_SHA256:
          prebuiltManifestSha256,
        FLIGHT_MAP_APPROVED_COMMIT_SHA: commitSha,
        FLIGHT_MAP_RELEASE_PHASE: "control-plane",
        AIRPORT_RELEASE_DEPLOYMENT_ID: "dpl_12345678",
        AIRPORT_RELEASE_DEPLOYMENT_URL:
          "https://flight-map-abc.vercel.app",
        AIRPORT_RELEASE_PRIOR_ALIAS_DEPLOYMENT_ID: "dpl_87654321",
        AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256:
          "1".repeat(64),
        FLIGHT_MAP_TARGET_FINGERPRINT: "2".repeat(64),
        FLIGHT_MAP_MIGRATION_MANIFEST_SHA256: "3".repeat(64),
      },
      new Date(),
      runGit,
      {
        verifyCandidate: async () =>
          ({
            source: { manifestSha256: "6".repeat(64) },
            deploymentSource: { manifestSha256: "7".repeat(64) },
          }) as never,
        loadPrebuilt: async () =>
          ({
            manifestSha256: prebuiltManifestSha256,
            manifest: {
              sourceCommitSha: commitSha,
              candidateManifestSha256,
              files: [
                {
                  path: ".vercel/output/config.json",
                  bytes: 2,
                  sha1: "8".repeat(40),
                  sha256: "9".repeat(64),
                },
              ],
            },
          }) as never,
      },
    );

    expect(expectation).toMatchObject({
      schemaVersion: 5,
      deploymentMethod: "vercel-cli-prebuilt",
      sourceCommit: {
        commitSha,
        ref: "main",
        repoId: "1338617639",
      },
      prebuiltArtifact: {
        manifestSha256: prebuiltManifestSha256,
      },
    });
  });
});
