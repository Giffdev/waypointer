import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  SignJWT,
} from "jose";
import { describe, expect, it, vi } from "vitest";
import { releaseRuntimeClaimsFromEnvironment } from "../src/lib/release-attestation";
import {
  providerReleaseExpectationSha256,
  RELEASE_DEPLOYMENT_TRUST,
  type ProviderReleaseExpectation,
  verifyImmutableReleaseCandidate,
  verifyReleaseEndpoint,
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

function expectationFixture(
  overrides: Partial<ProviderReleaseExpectation> = {},
): ProviderReleaseExpectation {
  const core = {
    schemaVersion: 5 as const,
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
    targetFingerprint: "5".repeat(64),
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
      rehashCore as Partial<ProviderReleaseExpectation>
    ).expectationSha256;
    expectation.expectationSha256 =
      providerReleaseExpectationSha256(
        rehashCore as Omit<
          ProviderReleaseExpectation,
          "expectationSha256"
        >,
      );
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
    FLIGHT_MAP_DEPLOYMENT_METHOD: expectation.deploymentMethod,
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
    FLIGHT_MAP_TARGET_FINGERPRINT: expectation.targetFingerprint,
    FLIGHT_MAP_MIGRATION_MANIFEST_SHA256:
      expectation.migrationManifestSha256,
    FLIGHT_MAP_CATALOG_CHECKSUM: expectation.catalogChecksum,
    FLIGHT_MAP_DATABASE_EVIDENCE_SHA256:
      expectation.databaseEvidenceSha256,
    FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
  });
}

function providerFileTree(expectation: ProviderReleaseExpectation) {
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
    fileTree?: unknown;
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
      });
    }
    if (url.pathname.endsWith("/files")) {
      return Response.json(
        options.fileTree ?? providerFileTree(expectation),
      );
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
