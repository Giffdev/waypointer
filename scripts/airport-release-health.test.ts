import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseRuntimeClaimsFromEnvironment } from "../src/lib/release-attestation";
import {
  RELEASE_DEPLOYMENT_TRUST,
  verifyApplicationHealth,
} from "./airport-release-health";
import {
  providerReleaseExpectationSha256,
  type ProviderReleaseExpectation,
} from "./vercel-provider-proof";

type FetchImplementation = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

const challenge = "h".repeat(43);
const expectedCodes: Record<string, string> = {
  "00A": "00A",
  K00A: "00A",
  W01: "W01",
  KW01: "W01",
  OMK: "OMK",
  KOMK: "OMK",
  S18: "S18",
  UIL: "UIL",
  KUIL: "UIL",
};

function expectationFixture(): ProviderReleaseExpectation {
  const fileContents = "{}\n";
  const core = {
    schemaVersion: 4 as const,
    proofMode: "vercel-api-source-and-oidc" as const,
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
    gitSource: {
      type: "github" as const,
      owner: RELEASE_DEPLOYMENT_TRUST.gitRepoOwner,
      repo: RELEASE_DEPLOYMENT_TRUST.gitRepoName,
      repoId: "123456",
      ref: "main",
      commitSha: "0".repeat(40),
    },
    sourceManifestSha256: "1".repeat(64),
    deploymentSource: {
      manifestSha256: "2".repeat(64),
      files: [
        {
          path: "package.json",
          bytes: Buffer.byteLength(fileContents),
          sha1: createHash("sha1").update(fileContents).digest("hex"),
          sha256: createHash("sha256").update(fileContents).digest("hex"),
        },
      ],
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
  return {
    ...core,
    expectationSha256: providerReleaseExpectationSha256(core),
  };
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
    VERCEL_GIT_PROVIDER: "github",
    VERCEL_GIT_REPO_OWNER: expectation.gitSource.owner,
    VERCEL_GIT_REPO_SLUG: expectation.gitSource.repo,
    VERCEL_GIT_REPO_ID: expectation.gitSource.repoId,
    VERCEL_GIT_COMMIT_REF: expectation.gitSource.ref,
    VERCEL_GIT_COMMIT_SHA: expectation.gitSource.commitSha,
    FLIGHT_MAP_RELEASE_PHASE: "database-released",
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

function providerFetchFor(expectation: ProviderReleaseExpectation) {
  return vi.fn<FetchImplementation>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v4/aliases/")) {
      return Response.json({
        alias: expectation.productionAlias,
        deploymentId: expectation.deploymentId,
        projectId: expectation.projectId,
        redirect: null,
        redirectStatusCode: null,
      });
    }
    if (url.pathname.endsWith("/files")) {
      return Response.json([
        {
          name: "package.json",
          type: "file",
          uid: expectation.deploymentSource.files[0]!.sha1,
          mode: 33188,
        },
      ]);
    }
    return Response.json({
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
      aliases: [expectation.productionAlias],
      gitSource: {
        type: "github",
        org: expectation.gitSource.owner,
        repo: expectation.gitSource.repo,
        repoId: Number(expectation.gitSource.repoId),
        ref: expectation.gitSource.ref,
        sha: expectation.gitSource.commitSha,
      },
    });
  });
}

describe("airport deployed application health", () => {
  it("requires same-origin health and records provider-bound route evidence", async () => {
    const expectation = expectationFixture();
    const providerFetch = providerFetchFor(expectation);
    const applicationFetch = vi.fn<FetchImplementation>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health/release") {
        return Response.json(
          {
            status: "ok",
            runtimeWriteMode: "read-only",
            challenge: url.searchParams.get("challenge"),
            runtime: runtimeClaims(expectation),
            providerIdentity: { oidcToken: "provider-signed-token" },
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (url.pathname === "/api/import/airports") {
        const query = url.searchParams.get("query") ?? "";
        return Response.json({
          airports: [{ code: expectedCodes[query], name: query }],
        });
      }
      return new Response("ok", { status: 200 });
    });
    await expect(
      verifyApplicationHealth(
        expectation,
        "__Secure-authjs.session-token=ephemeral-token-value",
        {
          vercelApiToken: "vercel-api-token-value",
          providerFetch: providerFetch as typeof fetch,
          applicationFetch: applicationFetch as typeof fetch,
          challenge,
          oidcVerify: async (_token, requestChallenge) => ({
            issuer:
              `https://oidc.vercel.com/${expectation.teamSlug}`,
            audience:
              `urn:flight-map:release-health:${requestChallenge}`,
            subject:
              `owner:${expectation.teamSlug}:project:` +
              `${expectation.projectName}:environment:production`,
            ownerId: expectation.orgId,
            projectId: expectation.projectId,
            environment: "production",
            issuedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            tokenSha256: "9".repeat(64),
          }),
        },
      ),
    ).resolves.toMatchObject({
      deploymentId: expectation.deploymentId,
      routesChecked: 5,
      airportQueriesChecked: 9,
    });
    for (const [input] of applicationFetch.mock.calls) {
      expect(new URL(String(input)).origin).toBe(
        `https://${expectation.productionAlias}`,
      );
    }
  });
});
