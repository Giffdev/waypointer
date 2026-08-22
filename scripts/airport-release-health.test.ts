import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseRuntimeClaimsFromEnvironment } from "../src/lib/release-attestation";
import {
  RELEASE_DEPLOYMENT_TRUST,
  verifyApplicationHealth,
  verifyHistoricalFlightBaseline,
} from "./airport-release-health";
import {
  providerReleaseExpectationSha256,
  type PrebuiltProviderReleaseExpectation,
  type ProviderReleaseExpectation,
} from "./vercel-provider-proof";

type FetchImplementation = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

type FlightSnapshotRow = {
  id: string;
  user_id: string;
  origin_airport_id: string;
  destination_airport_id: string;
  fingerprint: string;
  date: string;
};

function flightSnapshotHash(rows: FlightSnapshotRow[]) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

const challenge = "h".repeat(43);
const expectedCodes: Record<string, string> = {
  "00A": "00A",
  K00A: "00A",
  W01: "W01",
  KW01: "W01",
  OMK: "OMK",
  KOMK: "OMK",
  S18: "S18",
  DMK: "DMK",
  REP: "REP",
  VDSR: "REP",
  VDSA: "SAI",
  UIL: "UIL",
  KUIL: "UIL",
};

function expectationFixture(): PrebuiltProviderReleaseExpectation {
  const fileContents = "{}\n";
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
    VERCEL_PROJECT_PRODUCTION_URL:
      RELEASE_DEPLOYMENT_TRUST.projectProductionUrl,
    FLIGHT_MAP_DEPLOYMENT_METHOD: expectation.deploymentMethod,
    FLIGHT_MAP_GIT_PROVIDER: "github",
    FLIGHT_MAP_GIT_REPO_OWNER: expectation.sourceCommit.owner,
    FLIGHT_MAP_GIT_REPO_NAME: expectation.sourceCommit.repo,
    FLIGHT_MAP_GIT_REPO_ID: expectation.sourceCommit.repoId,
    FLIGHT_MAP_GIT_COMMIT_REF: expectation.sourceCommit.ref,
    FLIGHT_MAP_GIT_COMMIT_SHA: expectation.sourceCommit.commitSha,
    FLIGHT_MAP_RELEASE_PHASE: "database-released",
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

function providerFetchFor(
  expectation: PrebuiltProviderReleaseExpectation,
) {
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
          uid: expectation.prebuiltArtifact.files[0]!.sha1,
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
      gitSource: null,
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
            database: { defaultTransactionReadOnly: "on" },
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
      if (
        ["/map", "/flights", "/import", "/settings"].includes(
          url.pathname,
        )
      ) {
        return new Response("ok", { status: 200 });
      }
      return new Response("unexpected route", { status: 405 });
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
      airportQueriesChecked: 8,
      defaultTransactionReadOnly: "on",
    });
    for (const [input] of applicationFetch.mock.calls) {
      expect(new URL(String(input)).origin).toBe(
        `https://${expectation.productionAlias}`,
      );
    }
    const observedPaths = applicationFetch.mock.calls.map(([input]) =>
      new URL(String(input)).pathname
    );
    expect(observedPaths).toContain("/settings");
    expect(observedPaths).toContain("/import");
    expect(observedPaths).not.toContain("/");
    expect(observedPaths).not.toContain("/api/flights");
    const airportQueries = applicationFetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === "/api/import/airports")
      .map((url) => url.searchParams.get("query"));
    expect(airportQueries).toEqual([
      "00A",
      "W01",
      "OMK",
      "S18",
      "DMK",
      "REP",
      "VDSR",
      "VDSA",
    ]);
    expect(airportQueries).not.toContain("KOMK");
    expect(airportQueries).not.toContain("KUIL");
  });
});

describe("post-release historical flight health", () => {
  const baselineRows: FlightSnapshotRow[] = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      user_id: "00000000-0000-4000-8000-000000000010",
      origin_airport_id: "00000000-0000-4000-8000-000000000020",
      destination_airport_id:
        "00000000-0000-4000-8000-000000000021",
      fingerprint: "existing-one",
      date: "2018-01-01",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      user_id: "00000000-0000-4000-8000-000000000010",
      origin_airport_id: "00000000-0000-4000-8000-000000000022",
      destination_airport_id:
        "00000000-0000-4000-8000-000000000023",
      fingerprint: "existing-two",
      date: "2018-01-02",
    },
  ];
  const reconciledRows: FlightSnapshotRow[] = [
    {
      ...baselineRows[0]!,
      id: "00000000-0000-4000-8000-000000000003",
      fingerprint: "dmk-rep",
      date: "2018-10-23",
    },
    {
      ...baselineRows[0]!,
      id: "00000000-0000-4000-8000-000000000004",
      fingerprint: "rep-sin",
      date: "2018-10-26",
    },
  ];
  const before = {
    count: baselineRows.length,
    sha256: flightSnapshotHash(baselineRows),
    ids: [],
  };
  const reconciliation = {
    resolved: 2,
    completed: 1,
    conflicts: 0,
    ambiguous: 0,
    unknown: 0,
  };

  it("accepts only the exact reconciled REP imports while preserving the prior baseline", async () => {
    const unsafe = vi.fn(async (query: string) => {
      if (query.includes("to_regclass")) return [{ present: true }];
      if (query.includes("flights.source_type = 'FlightRadar24'")) {
        return reconciledRows.map(({ id }) => ({ id }));
      }
      if (query.includes("id <> all")) return baselineRows;
      return [...baselineRows, ...reconciledRows].sort((left, right) =>
        left.id.localeCompare(right.id)
      );
    });

    await expect(
      verifyHistoricalFlightBaseline({ unsafe }, before, reconciliation),
    ).resolves.toMatchObject({
      count: 4,
      sha256: flightSnapshotHash([
        ...baselineRows,
        ...reconciledRows,
      ]),
    });
    expect(unsafe).toHaveBeenCalledTimes(5);
  });

  it("rejects appended rows that do not reproduce the released baseline", async () => {
    const mutatedBaseline = [
      { ...baselineRows[0]!, fingerprint: "changed" },
      baselineRows[1]!,
    ];
    const unsafe = vi.fn(async (query: string) => {
      if (query.includes("to_regclass")) return [{ present: true }];
      if (query.includes("flights.source_type = 'FlightRadar24'")) {
        return reconciledRows.map(({ id }) => ({ id }));
      }
      if (query.includes("id <> all")) return mutatedBaseline;
      return [...mutatedBaseline, ...reconciledRows].sort(
        (left, right) => left.id.localeCompare(right.id),
      );
    });

    await expect(
      verifyHistoricalFlightBaseline({ unsafe }, before, reconciliation),
    ).rejects.toMatchObject({ diagnosticCode: "health-check-failed" });
  });
});
