import { createHash, generateKeyPairSync } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
} from "jose";
import { describe, expect, it, vi } from "vitest";
import { releaseRuntimeClaimsFromEnvironment } from "../src/lib/release-attestation";
import {
  canonicalJson,
  DEPLOYMENT_SOURCE_MANIFEST_SELECTION,
} from "./airport-release-provenance";
import {
  providerReleaseExpectationSha256,
  RELEASE_DEPLOYMENT_TRUST,
  sourceArchiveProviderParts,
  sourceBuildEventEvidence,
  type PrebuiltProviderReleaseExpectation,
  type ProviderReleaseExpectation,
  type SourceProviderReleaseExpectation,
  verifyDeploymentEndpoint,
  verifyImmutableDeploymentCandidate,
  verifyImmutableReleaseCandidate,
  verifyReleaseEndpoint,
  verifyVercelDeploymentOidcIdentity,
  verifyVercelOidcIdentity,
} from "./vercel-provider-proof";

type FetchImplementation = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

const challenge = "c".repeat(43);
const files = [
  {
    path: "package.json",
    bytes: 3,
    sha1: createHash("sha1").update("{}\n").digest("hex"),
    sha256: createHash("sha256").update("{}\n").digest("hex"),
  },
  {
    path: "src/app.ts",
    bytes: 11,
    sha1: createHash("sha1").update("export {};\n").digest("hex"),
    sha256: createHash("sha256").update("export {};\n").digest("hex"),
  },
];
const sourceContents = new Map([
  ["package.json", Buffer.from("{}\n")],
  ["src/app.ts", Buffer.from("export {};\n")],
]);

function tarArchive(
  entries: readonly { path: string; contents: Buffer }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(
      `${entry.contents.length.toString(8).padStart(11, "0")}\0`,
      124,
      12,
      "ascii",
    );
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
    blocks.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const sourceArchive = tarArchive(
  files.map(({ path: filePath }) => ({
    path: filePath,
    contents: sourceContents.get(filePath)!,
  })),
);
const sourceArchiveSha1 = createHash("sha1")
  .update(sourceArchive)
  .digest("hex");
const sourceEvents = [
  {
    date: 1,
    type: "stdout",
    text: "Extracted 2 deployment files...",
  },
  {
    date: 2,
    type: "stderr",
    text: "Build Completed in /vercel/output [6m]",
  },
  { date: 3, type: "stdout", text: "Deploying outputs..." },
];

function expectationFixture(
  overrides: Partial<PrebuiltProviderReleaseExpectation> = {},
): PrebuiltProviderReleaseExpectation {
  const core = {
    schemaVersion: 7 as const,
    proofMode: "vercel-cli-prebuilt-provider-oidc-alias" as const,
    deploymentMethod: "vercel-cli-prebuilt" as const,
    platform: "vercel" as const,
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    orgId: RELEASE_DEPLOYMENT_TRUST.orgId,
    teamSlug: RELEASE_DEPLOYMENT_TRUST.teamSlug,
    projectName: RELEASE_DEPLOYMENT_TRUST.projectName,
    environment: "production" as const,
    productionAlias: RELEASE_DEPLOYMENT_TRUST.productionAlias,
    releasePhase: "database-released" as const,
    deploymentId: "dpl_12345678",
    deploymentUrl: "https://flight-map-abc123.vercel.app",
    priorAliasDeploymentId: "dpl_87654321",
    sourceCommit: {
      type: "github" as const,
      owner: RELEASE_DEPLOYMENT_TRUST.gitRepoOwner,
      repo: RELEASE_DEPLOYMENT_TRUST.gitRepoName,
      repoId: RELEASE_DEPLOYMENT_TRUST.gitRepoId,
      ref: "main",
      commitSha: "0".repeat(40),
    },
    sourceManifestSha256: "1".repeat(64),
    deploymentSource: {
      manifestSha256: "2".repeat(64),
    },
    prebuiltArtifact: {
      manifestSha256: "a".repeat(64),
      files,
    },
    candidateManifestSha256: "3".repeat(64),
    approvedAirportCandidateSha256: "4".repeat(64),
    migrationManifestSha256: "6".repeat(64),
    catalogChecksum: "7".repeat(64),
    databaseEvidenceSha256: "8".repeat(64),
    writesPaused: true as const,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60 * 1_000).toISOString(),
  };
  const expectation = {
    ...core,
    expectationSha256: providerReleaseExpectationSha256(core),
    ...overrides,
  };
  if (!overrides.expectationSha256) {
    const rehashCore = { ...expectation };
    delete (
      rehashCore as Partial<PrebuiltProviderReleaseExpectation>
    ).expectationSha256;
    expectation.expectationSha256 =
      providerReleaseExpectationSha256(
        rehashCore as Omit<
          PrebuiltProviderReleaseExpectation,
          "expectationSha256"
        >,
      );
  }
  return expectation;
}

function sourceExpectationFixture(
  overrides: Partial<SourceProviderReleaseExpectation> = {},
): SourceProviderReleaseExpectation {
  const prebuilt = expectationFixture();
  const {
    prebuiltArtifact: _prebuiltArtifact,
    expectationSha256: _expectationSha256,
    proofMode: _proofMode,
    deploymentMethod: _deploymentMethod,
    ...base
  } = prebuilt;
  void _prebuiltArtifact;
  void _expectationSha256;
  void _proofMode;
  void _deploymentMethod;
  const core = {
    ...base,
    deploymentSource: {
      manifestSha256: createHash("sha256")
        .update(
          canonicalJson({
            schemaVersion: 1,
            role: "vercel-cli-source",
            selection: {
              roots: [...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.roots],
              topLevelFiles: [
                ...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.topLevelFiles,
              ],
              extraFiles: [
                ...DEPLOYMENT_SOURCE_MANIFEST_SELECTION.extraFiles,
              ],
            },
            files,
          }),
        )
        .digest("hex"),
    },
    proofMode: "vercel-cli-source-provider-oidc-alias" as const,
    deploymentMethod: "vercel-cli-source" as const,
    runtimeAttestation: {
      schemaVersion: 6 as const,
      deploymentMethod: "vercel-cli-prebuilt" as const,
    },
    sourceArchive: {
      format: "tgz" as const,
      fileCount: files.length,
      files,
      providerRootDirectory: "artifacts/source-deploy-stage",
      providerParts: [
        {
          path: ".vercel/source.tgz.part1",
          sha1: sourceArchiveSha1,
        },
      ],
      archiveSha256: createHash("sha256")
        .update(sourceArchive)
        .digest("hex"),
      ...sourceBuildEventEvidence(sourceEvents),
    },
  };
  const expectation = {
    ...core,
    expectationSha256: providerReleaseExpectationSha256(core),
    ...overrides,
  } as SourceProviderReleaseExpectation;
  if (!overrides.expectationSha256) {
    const rehashCore = { ...expectation };
    delete (
      rehashCore as Partial<SourceProviderReleaseExpectation>
    ).expectationSha256;
    expectation.expectationSha256 =
      providerReleaseExpectationSha256(rehashCore);
  }
  return expectation;
}

function runtimeClaims(expectation: ProviderReleaseExpectation) {
  return releaseRuntimeClaimsFromEnvironment({
    NODE_ENV: "test",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production",
    VERCEL_DEPLOYMENT_ID: expectation.deploymentId,
    VERCEL_URL: new URL(expectation.deploymentUrl).hostname,
    VERCEL_PROJECT_ID: expectation.projectId,
    VERCEL_PROJECT_PRODUCTION_URL: expectation.productionAlias,
    FLIGHT_MAP_DEPLOYMENT_METHOD:
      expectation.proofMode ===
      "vercel-cli-source-provider-oidc-alias"
        ? expectation.runtimeAttestation.deploymentMethod
        : expectation.deploymentMethod,
    FLIGHT_MAP_GIT_PROVIDER: expectation.sourceCommit.type,
    FLIGHT_MAP_GIT_REPO_OWNER: expectation.sourceCommit.owner,
    FLIGHT_MAP_GIT_REPO_NAME: expectation.sourceCommit.repo,
    FLIGHT_MAP_GIT_REPO_ID: expectation.sourceCommit.repoId,
    FLIGHT_MAP_GIT_COMMIT_REF: expectation.sourceCommit.ref,
    FLIGHT_MAP_GIT_COMMIT_SHA: expectation.sourceCommit.commitSha,
    FLIGHT_MAP_RELEASE_PHASE: expectation.releasePhase,
    FLIGHT_MAP_SOURCE_MANIFEST_SHA256:
      expectation.sourceManifestSha256,
    FLIGHT_MAP_DEPLOYMENT_SOURCE_MANIFEST_SHA256:
      expectation.deploymentSource.manifestSha256,
    FLIGHT_MAP_CANDIDATE_MANIFEST_SHA256:
      expectation.candidateManifestSha256,
    FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256:
      expectation.approvedAirportCandidateSha256,
    FLIGHT_MAP_MIGRATION_MANIFEST_SHA256:
      expectation.migrationManifestSha256,
    FLIGHT_MAP_CATALOG_CHECKSUM: expectation.catalogChecksum,
    FLIGHT_MAP_DATABASE_EVIDENCE_SHA256:
      expectation.databaseEvidenceSha256,
    FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
  });
}

function providerFileTree(expectation: ProviderReleaseExpectation) {
  if (
    expectation.proofMode ===
    "vercel-cli-source-provider-oidc-alias"
  ) {
    return [
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
                uid: expectation.sourceArchive.providerParts[0]!.sha1,
                mode: 438,
              },
            ],
          },
        ],
      },
      {
        name: "out",
        type: "directory",
        children: [
          {
            name: "index",
            type: "lambda",
            uid: "provider-lambda",
            mode: 49590,
          },
        ],
      },
    ];
  }
  return [
    {
      name: "package.json",
      type: "file",
      uid: expectation.prebuiltArtifact.files[0]!.sha1,
      mode: 33188,
    },
    {
      name: "src",
      type: "directory",
      mode: 16877,
      children: [
        {
          name: "app.ts",
          type: "file",
          uid: expectation.prebuiltArtifact.files[1]!.sha1,
          mode: 33188,
        },
      ],
    },
  ];
}

function providerFetchFor(
  expectation: ProviderReleaseExpectation,
  options: {
    aliasDeploymentIds?: string[];
    deploymentOverrides?: Record<string, unknown>;
    hostDeploymentOverrides?: Record<string, unknown>;
    aliasOverrides?: Record<string, unknown>;
    fileTree?: unknown;
    events?: unknown;
    failPath?: string;
    immutable?: boolean;
  } = {},
) {
  let aliasRequest = 0;
  return vi.fn<FetchImplementation>(async (input) => {
    const url = new URL(String(input));
    if (options.failPath && url.pathname.includes(options.failPath)) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    if (url.pathname.startsWith("/v4/aliases/")) {
      const deploymentId =
        options.aliasDeploymentIds?.[aliasRequest] ??
        (options.immutable
          ? expectation.priorAliasDeploymentId
          : expectation.deploymentId);
      aliasRequest += 1;
      return Response.json({
        alias: expectation.productionAlias,
        deploymentId,
        projectId: expectation.projectId,
        redirect: null,
        redirectStatusCode: null,
        ...options.aliasOverrides,
      });
    }
    if (url.pathname.endsWith("/files")) {
      return Response.json(
        options.fileTree ?? providerFileTree(expectation),
      );
    }
    if (url.pathname.endsWith("/events")) {
      return Response.json(options.events ?? sourceEvents);
    }
    if (/\/files\/[a-f0-9]{40}$/.test(url.pathname)) {
      return Response.json({
        data: sourceArchive.toString("base64"),
      });
    }
    const base = {
      id: expectation.deploymentId,
      name: expectation.projectName,
      url: new URL(expectation.deploymentUrl).hostname,
      projectId: expectation.projectId,
      ownerId: expectation.orgId,
      team: {
        id: expectation.orgId,
        slug: expectation.teamSlug,
      },
      target: "production",
      readyState: "READY",
      aliases: options.immutable ? [] : [expectation.productionAlias],
      gitSource: null,
      ...(expectation.proofMode ===
      "vercel-cli-source-provider-oidc-alias"
        ? {
            source: "cli",
            buildSkipped: false,
            meta: {
              githubCommitOrg: expectation.sourceCommit.owner,
              githubCommitRef: expectation.sourceCommit.ref,
              githubCommitRepo: expectation.sourceCommit.repo,
              githubCommitSha: expectation.sourceCommit.commitSha,
              gitRootDirectory:
                expectation.sourceArchive.providerRootDirectory,
            },
          }
        : {}),
    };
    const byHost = decodeURIComponent(url.pathname).includes(
      new URL(expectation.deploymentUrl).hostname,
    );
    return Response.json({
      ...base,
      ...(byHost
        ? options.hostDeploymentOverrides
        : options.deploymentOverrides),
    });
  });
}

const oidcEvidence = async (_token: string, requestChallenge: string) => ({
  issuer: `https://oidc.vercel.com/${RELEASE_DEPLOYMENT_TRUST.teamSlug}`,
  audience: `urn:flight-map:release-health:${requestChallenge}`,
  subject:
    `owner:${RELEASE_DEPLOYMENT_TRUST.teamSlug}:` +
    `project:${RELEASE_DEPLOYMENT_TRUST.projectName}:` +
    "environment:production",
  ownerId: RELEASE_DEPLOYMENT_TRUST.orgId,
  projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
  environment: "production",
  issuedAt: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  tokenSha256: "9".repeat(64),
});

function applicationFetchFor(
  expectation: ProviderReleaseExpectation,
  overrides: Record<string, unknown> = {},
) {
  return vi.fn<FetchImplementation>(async (input) => {
    const url = new URL(String(input));
    return Response.json(
      {
        status: "ok",
        runtimeWriteMode: "read-only",
        database: { defaultTransactionReadOnly: "on" },
        challenge: url.searchParams.get("challenge"),
        runtime: runtimeClaims(expectation),
        providerIdentity: { oidcToken: "provider-signed-token" },
        ...overrides,
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}

describe("Vercel provider proof", () => {
  it("orders multipart source archives by numeric suffix", () => {
    const children = Array.from({ length: 10 }, (_, index) => ({
      name: `source.tgz.part${index + 1}`,
      type: "invalid",
      uid: (index + 1).toString(16).padStart(40, "0"),
      mode: 438,
    })).sort((left, right) => left.name.localeCompare(right.name));
    expect(
      sourceArchiveProviderParts([
        {
          name: "src",
          type: "directory",
          children: [
            {
              name: ".vercel",
              type: "directory",
              children,
            },
          ],
        },
      ]).map(({ path: filePath }) => filePath),
    ).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `.vercel/source.tgz.part${index + 1}`,
      ),
    );
  });

  it("verifies a Vercel-signed, challenge-bound OIDC identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "vercel-test-key";
    publicJwk.alg = "RS256";
    const now = Math.floor(Date.now() / 1_000);
    const subject =
      `owner:${RELEASE_DEPLOYMENT_TRUST.teamSlug}:` +
      `project:${RELEASE_DEPLOYMENT_TRUST.projectName}:` +
      "environment:production";
    const token = await new SignJWT({
      owner: RELEASE_DEPLOYMENT_TRUST.teamSlug,
      owner_id: RELEASE_DEPLOYMENT_TRUST.orgId,
      project: RELEASE_DEPLOYMENT_TRUST.projectName,
      project_id: RELEASE_DEPLOYMENT_TRUST.projectId,
      environment: "production",
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "vercel-test-key",
        typ: "JWT",
      })
      .setIssuer(
        `https://oidc.vercel.com/${RELEASE_DEPLOYMENT_TRUST.teamSlug}`,
      )
      .setAudience(`urn:flight-map:release-health:${challenge}`)
      .setSubject(subject)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(privateKey);
    await expect(
      verifyVercelOidcIdentity(
        token,
        challenge,
        createLocalJWKSet({ keys: [publicJwk] }),
      ),
    ).resolves.toMatchObject({
      ownerId: RELEASE_DEPLOYMENT_TRUST.orgId,
      projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    });

    const deploymentToken = await new SignJWT({
      owner: RELEASE_DEPLOYMENT_TRUST.teamSlug,
      owner_id: RELEASE_DEPLOYMENT_TRUST.orgId,
      project: RELEASE_DEPLOYMENT_TRUST.projectName,
      project_id: RELEASE_DEPLOYMENT_TRUST.projectId,
      environment: "production",
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "vercel-test-key",
        typ: "JWT",
      })
      .setIssuer(
        `https://oidc.vercel.com/${RELEASE_DEPLOYMENT_TRUST.teamSlug}`,
      )
      .setAudience(
        `urn:flight-map:deployment-attestation:${challenge}`,
      )
      .setSubject(subject)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(privateKey);
    await expect(
      verifyVercelDeploymentOidcIdentity(
        deploymentToken,
        challenge,
        createLocalJWKSet({ keys: [publicJwk] }),
      ),
    ).resolves.toMatchObject({
      audience:
        `urn:flight-map:deployment-attestation:${challenge}`,
    });

    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = await new SignJWT({
      owner: RELEASE_DEPLOYMENT_TRUST.teamSlug,
      owner_id: RELEASE_DEPLOYMENT_TRUST.orgId,
      project: RELEASE_DEPLOYMENT_TRUST.projectName,
      project_id: RELEASE_DEPLOYMENT_TRUST.projectId,
      environment: "production",
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "vercel-test-key",
        typ: "JWT",
      })
      .setIssuer(
        `https://oidc.vercel.com/${RELEASE_DEPLOYMENT_TRUST.teamSlug}`,
      )
      .setAudience(`urn:flight-map:release-health:${challenge}`)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .sign(attacker.privateKey);
    await expect(
      verifyVercelOidcIdentity(
        forged,
        challenge,
        createLocalJWKSet({ keys: [publicJwk] }),
      ),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });
  });

  it("binds live alias health to exact provider source and deployment", async () => {
    const expectation = expectationFixture();
    const providerFetch = providerFetchFor(expectation);
    const applicationFetch = applicationFetchFor(expectation);
    await expect(
      verifyReleaseEndpoint(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch: providerFetch as typeof fetch,
          applicationFetch: applicationFetch as typeof fetch,
          oidcVerify: oidcEvidence,
          challenge,
        },
      ),
    ).resolves.toMatchObject({
      deploymentId: expectation.deploymentId,
      providerSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      oidcTokenSha256: "9".repeat(64),
    });

    expect(applicationFetch).toHaveBeenCalledTimes(1);
    const [input, init] = applicationFetch.mock.calls[0]!;
    expect(new URL(String(input)).origin).toBe(
      `https://${expectation.productionAlias}`,
    );
    expect(init?.redirect).toBe("manual");
  });

  it("verifies the immutable deployment while the production alias remains unchanged", async () => {
    const expectation = expectationFixture();
    const applicationFetch = applicationFetchFor(expectation);
    await expect(
      verifyImmutableReleaseCandidate(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch: providerFetchFor(expectation, {
            immutable: true,
          }) as typeof fetch,
          applicationFetch: applicationFetch as typeof fetch,
          oidcVerify: oidcEvidence,
          challenge,
        },
      ),
    ).resolves.toMatchObject({
      origin: expectation.deploymentUrl,
      aliasDeploymentId: expectation.priorAliasDeploymentId,
    });
    expect(
      new URL(String(applicationFetch.mock.calls[0]![0])).origin,
    ).toBe(expectation.deploymentUrl);
  });

  it("verifies control-plane deployment attestation without a user session", async () => {
    const expectation = expectationFixture({
      releasePhase: "control-plane",
      catalogChecksum: undefined,
      databaseEvidenceSha256: undefined,
    });
    const applicationFetch = applicationFetchFor(expectation);

    await expect(
      verifyImmutableDeploymentCandidate(expectation, {
        providerFetch: providerFetchFor(expectation, {
          immutable: true,
        }) as typeof fetch,
        applicationFetch: applicationFetch as typeof fetch,
        oidcVerify: oidcEvidence,
        challenge,
      }),
    ).resolves.toMatchObject({
      origin: expectation.deploymentUrl,
      aliasDeploymentId: expectation.priorAliasDeploymentId,
    });

    expect(
      new URL(String(applicationFetch.mock.calls[0]![0])).pathname,
    ).toBe("/api/health/deployment");
  });

  it("verifies promoted deployment attestation without a user session", async () => {
    const expectation = expectationFixture({
      releasePhase: "control-plane",
      catalogChecksum: undefined,
      databaseEvidenceSha256: undefined,
    });
    await expect(
      verifyDeploymentEndpoint(expectation, {
        providerFetch:
          providerFetchFor(expectation) as typeof fetch,
        applicationFetch:
          applicationFetchFor(expectation) as typeof fetch,
        oidcVerify: oidcEvidence,
        challenge,
      }),
    ).resolves.toMatchObject({
      origin: `https://${expectation.productionAlias}`,
      aliasDeploymentId: expectation.deploymentId,
    });
  });

  it("verifies an authoritative CLI source archive without a prebuilt tree", async () => {
    const expectation = sourceExpectationFixture({
      releasePhase: "control-plane",
      catalogChecksum: undefined,
      databaseEvidenceSha256: undefined,
    });
    await expect(
      verifyDeploymentEndpoint(expectation, {
        providerFetch:
          providerFetchFor(expectation) as typeof fetch,
        applicationFetch:
          applicationFetchFor(expectation) as typeof fetch,
        oidcVerify: oidcEvidence,
        challenge,
      }),
    ).resolves.toMatchObject({
      deploymentId: expectation.deploymentId,
      providerSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    [
      "provider source",
      { deploymentOverrides: { source: "git" } },
    ],
    [
      "provider project",
      { deploymentOverrides: { projectId: "prj_attacker123" } },
    ],
    [
      "extracted file count",
      {
        events: sourceEvents.map((event) => ({
          ...event,
          text: event.text.replace(
            "Extracted 2",
            "Extracted 3",
          ),
        })),
      },
    ],
    [
      "archive substitution",
      {
        fileTree: [
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
                    uid: "f".repeat(40),
                    mode: 438,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      "alias redirect",
      { aliasOverrides: { redirectStatusCode: 308 } },
    ],
  ])("rejects source-mode %s mismatch", async (_label, options) => {
    const expectation = sourceExpectationFixture({
      releasePhase: "control-plane",
      catalogChecksum: undefined,
      databaseEvidenceSha256: undefined,
    });
    const applicationFetch = applicationFetchFor(expectation);
    await expect(
      verifyDeploymentEndpoint(expectation, {
        providerFetch: providerFetchFor(
          expectation,
          options,
        ) as typeof fetch,
        applicationFetch: applicationFetch as typeof fetch,
        oidcVerify: oidcEvidence,
        challenge,
      }),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });
    expect(applicationFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unexpected provider Git metadata",
      { deploymentOverrides: { gitSource: { sha: "f".repeat(40) } } },
    ],
    [
      "different repository",
      {
        deploymentOverrides: {
          gitSource: {
            type: "github",
            org: "attacker",
            repo: "flight-map",
            repoId: 123456,
            ref: "main",
            sha: "0".repeat(40),
          },
        },
      },
    ],
    [
      "excluded deployment input",
      {
        fileTree: [
          ...providerFileTree(expectationFixture()),
          {
            name: "vercel.json",
            type: "file",
            uid: "f".repeat(40),
            mode: 33188,
          },
        ],
      },
    ],
    ["provider query failure", { failPath: "/files" }],
  ])("blocks %s before contacting application health", async (_label, options) => {
    const expectation = expectationFixture();
    const applicationFetch = applicationFetchFor(expectation);
    await expect(
      verifyReleaseEndpoint(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch: providerFetchFor(
            expectation,
            options,
          ) as typeof fetch,
          applicationFetch: applicationFetch as typeof fetch,
          oidcVerify: oidcEvidence,
          challenge,
        },
      ),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });
    expect(applicationFetch).not.toHaveBeenCalled();
  });

  it("catches alias drift and runtime deployment forgery", async () => {
    const expectation = expectationFixture();
    await expect(
      verifyReleaseEndpoint(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch: providerFetchFor(expectation, {
            aliasDeploymentIds: [
              expectation.deploymentId,
              expectation.deploymentId,
              "dpl_replaced123",
            ],
          }) as typeof fetch,
          applicationFetch:
            applicationFetchFor(expectation) as typeof fetch,
          oidcVerify: oidcEvidence,
          challenge,
        },
      ),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });

    const forgedRuntime = runtimeClaims(expectation);
    forgedRuntime.deploymentId = "dpl_attacker123";
    await expect(
      verifyReleaseEndpoint(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch:
            providerFetchFor(expectation) as typeof fetch,
          applicationFetch: applicationFetchFor(expectation, {
            runtime: forgedRuntime,
          }) as typeof fetch,
          oidcVerify: oidcEvidence,
          challenge,
        },
      ),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });
  });
});
