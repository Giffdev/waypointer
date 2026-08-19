import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthoritativeProviderInspection,
  createProviderReleaseExpectation,
  loadAuthoritativeProviderInspection,
  resolveCleanGitSource,
  type ProviderJsonLoader,
} from "./create-vercel-provider-expectation";
import { RELEASE_DEPLOYMENT_TRUST } from "./vercel-provider-proof";

const sourceFileContents = Buffer.from("{}\n");
const sourceFile = {
  path: "package.json",
  bytes: sourceFileContents.length,
  sha1: createHash("sha1").update(sourceFileContents).digest("hex"),
  sha256: createHash("sha256").update(sourceFileContents).digest("hex"),
};

function sourceArchive(): Buffer {
  const header = Buffer.alloc(512);
  header.write(sourceFile.path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000003\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    148,
    8,
    "ascii",
  );
  return gzipSync(
    Buffer.concat([
      header,
      sourceFileContents,
      Buffer.alloc(509),
      Buffer.alloc(1024),
    ]),
  );
}

const sourceArchiveBytes = sourceArchive();
const sourceArchiveSha1 = createHash("sha1")
  .update(sourceArchiveBytes)
  .digest("hex");

function providerInspection(
  mode: "prebuilt" | "source",
  overrides: Partial<AuthoritativeProviderInspection> = {},
): AuthoritativeProviderInspection {
  const deployment = {
    id: "dpl_12345678",
    name: RELEASE_DEPLOYMENT_TRUST.projectName,
    url: "flight-map-abc.vercel.app",
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    ownerId: RELEASE_DEPLOYMENT_TRUST.orgId,
    target: "production",
    readyState: "READY",
    gitSource: null,
    team: {
      id: RELEASE_DEPLOYMENT_TRUST.orgId,
      slug: RELEASE_DEPLOYMENT_TRUST.teamSlug,
    },
    ...(mode === "source"
      ? {
          source: "cli",
          buildSkipped: false,
          meta: {
            githubCommitOrg: "Giffdev",
            githubCommitRef: "main",
            githubCommitRepo: "waypointer",
            githubCommitSha: "0".repeat(40),
            gitRootDirectory: "artifacts/source-deploy-stage",
          },
        }
      : {}),
  };
  const alias = {
    alias: RELEASE_DEPLOYMENT_TRUST.productionAlias,
    deploymentId:
      mode === "prebuilt" ? "dpl_87654321" : "dpl_12345678",
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    redirect: null,
    redirectStatusCode: null,
  };
  return {
    aliasBefore: alias,
    aliasAfter: alias,
    deployment,
    deploymentByHost: { ...deployment },
    files:
      mode === "source"
        ? [
            {
              name: "src",
              type: "directory",
              children: [
                {
                  name: ".vercel",
                  type: "directory",
                  children: [
                    {
                      name: "source.tgz.part1",
                      type: "invalid",
                      uid: sourceArchiveSha1,
                      mode: 438,
                    },
                  ],
                },
              ],
            },
          ]
        : [
            {
              name: ".vercel",
              type: "directory",
              children: [
                {
                  name: "output",
                  type: "directory",
                  children: [
                    {
                      name: "config.json",
                      type: "file",
                      uid: "8".repeat(40),
                      mode: 33188,
                    },
                  ],
                },
              ],
            },
          ],
    events:
      mode === "source"
        ? [
            {
              date: 1,
              type: "stdout",
              text: "Extracted 1 deployment files...",
            },
            {
              date: 2,
              type: "stderr",
              text: "Build Completed in /vercel/output [1s]",
            },
            {
              date: 3,
              type: "stdout",
              text: "Deploying outputs...",
            },
          ]
        : [],
    archiveParts:
      mode === "source"
        ? [
            {
              uid: sourceArchiveSha1,
              data: sourceArchiveBytes.toString("base64"),
            },
          ]
        : undefined,
    ...overrides,
  };
}

describe("provider expectation Git pin", () => {
  it("does not query source-only evidence for a prebuilt deployment", async () => {
    const fixture = providerInspection("prebuilt");
    const requested: string[] = [];
    const loadProviderJson = (async (providerPath: string) => {
      requested.push(providerPath);
      if (providerPath.startsWith("/v4/aliases/")) {
        return fixture.aliasBefore;
      }
      if (providerPath.endsWith("/files?teamId=team_qymLK9gugmE5lSs2mxC5XqRY")) {
        return fixture.files;
      }
      return fixture.deployment;
    }) as ProviderJsonLoader;

    await expect(
      loadAuthoritativeProviderInspection(
        { NODE_ENV: "test" },
        "dpl_12345678",
        "https://flight-map-abc.vercel.app",
        loadProviderJson,
      ),
    ).resolves.toMatchObject({
      events: [],
      archiveParts: undefined,
    });
    expect(requested.some((request) => request.includes("/events"))).toBe(
      false,
    );
    expect(
      requested.some((request) => request.startsWith("/v8/deployments/")),
    ).toBe(false);
  });

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
        FLIGHT_MAP_MIGRATION_MANIFEST_SHA256: "3".repeat(64),
      },
      new Date(),
      runGit,
      {
        loadProvider: async () => providerInspection("prebuilt"),
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
      schemaVersion: 7,
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
    expect(expectation).not.toHaveProperty("targetFingerprint");
  });

  it("selects source mode from provider archive metadata without a prebuilt input", async () => {
    const commitSha = "0".repeat(40);
    const candidateManifestSha256 = "4".repeat(64);
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("f".repeat(40))
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("https://github.com/Giffdev/waypointer.git")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    const expectation = await createProviderReleaseExpectation(
      {
        NODE_ENV: "test",
        AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH:
          "artifacts/release-evidence/airport-catalog/candidate-test.json",
        AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256:
          candidateManifestSha256,
        FLIGHT_MAP_APPROVED_COMMIT_SHA: commitSha,
        FLIGHT_MAP_RELEASE_PHASE: "control-plane",
        AIRPORT_RELEASE_DEPLOYMENT_ID: "dpl_12345678",
        AIRPORT_RELEASE_DEPLOYMENT_URL:
          "https://flight-map-abc.vercel.app",
        AIRPORT_RELEASE_PRIOR_ALIAS_DEPLOYMENT_ID: "dpl_87654321",
        AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256:
          "1".repeat(64),
        FLIGHT_MAP_MIGRATION_MANIFEST_SHA256: "3".repeat(64),
      },
      new Date(),
      runGit,
      {
        loadProvider: async () => providerInspection("source"),
        loadCandidate: async () =>
          ({
            source: { manifestSha256: "6".repeat(64) },
            deploymentSource: {
              manifestSha256: "7".repeat(64),
              files: [
                sourceFile,
              ],
            },
          }) as never,
      },
    );

    expect(expectation).toMatchObject({
      schemaVersion: 7,
      proofMode: "vercel-cli-source-provider-oidc-alias",
      deploymentMethod: "vercel-cli-source",
      sourceCommit: { commitSha },
      sourceArchive: {
        format: "tgz",
        fileCount: 1,
        extractedFileCount: 1,
        providerRootDirectory: "artifacts/source-deploy-stage",
        providerParts: [
          {
            path: ".vercel/source.tgz.part1",
            sha1: sourceArchiveSha1,
          },
        ],
      },
    });
    expect(expectation).not.toHaveProperty("prebuiltArtifact");
    expect(runGit).toHaveBeenNthCalledWith(5, [
      "cat-file",
      "-e",
      `${commitSha}^{commit}`,
    ]);
  });

  it.each([
    [
      "mixed source and prebuilt provenance",
      providerInspection("source"),
      {
        FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_PATH:
          "artifacts/release-evidence/vercel-prebuilt-artifact/manifest-test.json",
        FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_SHA256: "5".repeat(64),
      },
    ],
    [
      "alias ownership mismatch",
      providerInspection("source", {
        aliasAfter: {
          alias: RELEASE_DEPLOYMENT_TRUST.productionAlias,
          deploymentId: "dpl_attacker123",
          projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
          redirect: null,
          redirectStatusCode: null,
        },
      }),
      {},
    ],
    [
      "provider source mismatch",
      providerInspection("source", {
        deployment: {
          ...providerInspection("source").deployment,
          source: "git",
        },
      }),
      {},
    ],
  ])("rejects %s", async (_label, provider, extraEnvironment) => {
    const runGit = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("f".repeat(40))
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("https://github.com/Giffdev/waypointer.git")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    await expect(
      createProviderReleaseExpectation(
        {
          NODE_ENV: "test",
          AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH:
            "artifacts/release-evidence/airport-catalog/candidate-test.json",
          AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256: "4".repeat(64),
          FLIGHT_MAP_APPROVED_COMMIT_SHA: "0".repeat(40),
          FLIGHT_MAP_RELEASE_PHASE: "control-plane",
          AIRPORT_RELEASE_DEPLOYMENT_ID: "dpl_12345678",
          AIRPORT_RELEASE_DEPLOYMENT_URL:
            "https://flight-map-abc.vercel.app",
          AIRPORT_RELEASE_PRIOR_ALIAS_DEPLOYMENT_ID: "dpl_87654321",
          AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256:
            "1".repeat(64),
          FLIGHT_MAP_MIGRATION_MANIFEST_SHA256: "3".repeat(64),
          ...extraEnvironment,
        },
        new Date(),
        runGit,
        {
          loadProvider: async () => provider,
          loadCandidate: async () =>
            ({
              source: { manifestSha256: "6".repeat(64) },
              deploymentSource: {
                manifestSha256: "7".repeat(64),
                files: [
                  sourceFile,
                ],
              },
            }) as never,
        },
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "candidate-provenance-mismatch",
    });
  });
});
