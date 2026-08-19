import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createCandidateManifest,
  sha256Bytes,
  writeContentAddressedJson,
} from "./airport-release-provenance";
import {
  AIRPORT_RELEASE_CONFIRMATION_PREFIX,
  type AirportRollbackStopCondition,
  airportDatabaseTargetFingerprint,
  type AirportReleaseTargetApproval,
  requireAirportReleaseTarget,
  withVerifiedAirportReleaseTarget,
} from "./airport-release-safety";

const root = process.cwd();
const fixtureId = `unit-${process.pid}`;
const approvalDirectory = path.join(
  root,
  "data",
  "private",
  "release-approvals",
  fixtureId,
);
const evidenceDirectory = path.join(
  root,
  "artifacts",
  "release-evidence",
  "airport-catalog",
  fixtureId,
);
let baseEnvironment: NodeJS.ProcessEnv;
let baseApproval: ReturnType<typeof approvalPayload>;

function databaseUrl(user: string, password: string, database: string) {
  return `postgresql:${"/".repeat(2)}${user}:${password}@db.example.test:5432/${database}?sslmode=require`;
}

function approvalPayload(
  now = Date.now(),
): AirportReleaseTargetApproval {
  const snapshotId = "test-snapshot";
  const restoreProcedure = {
    schemaVersion: 1 as const,
    stopConditions: [
      "database-release-post-commit-health-failed",
      "deployment-attestation-mismatch",
      "evidence-persistence-failed",
      "promotion-health-failed",
    ] as AirportRollbackStopCondition[],
    transactionSemantics: "serializable-database-release" as const,
    stagingSemantics: "live-production-alias-read-only-control-plane" as const,
    restoreCommand: {
      executable: "provider-cli",
      args: ["restore", snapshotId],
    },
    verificationCommand: {
      executable: "npm",
      args: ["run", "db:airport-rollback-verify"],
    },
  };
  return {
    schemaVersion: 3 as const,
    approvalId: fixtureId,
    environment: "test",
    targetFingerprint: "",
    databaseName: "flight_map",
    databaseOid: 16_384,
    candidateManifestSha256: "",
    approvedAt: new Date(now - 5_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    changeControl: {
      mechanism: "application-read-only-plus-database-barrier" as const,
      staging: "live-production-alias-read-only-control-plane" as const,
      pauseEvidenceSha256: "b".repeat(64),
      importsPausedAt: new Date(now - 4_000).toISOString(),
      verifiedAt: new Date(now - 3_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    },
    snapshot: {
      id: snapshotId,
      sha256: "a".repeat(64),
      preChangeStateSha256: "c".repeat(64),
      restoreProcedureSha256: sha256Bytes(
        canonicalJson(restoreProcedure),
      ),
      createdAt: new Date(now - 2_000).toISOString(),
      verifiedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      restoreProcedure,
    },
  };
}

beforeAll(async () => {
  const migrationDatabaseUrl = databaseUrl(
    "migration",
    "first-secret",
    "flight_map",
  );
  const candidate = await writeContentAddressedJson(
    evidenceDirectory,
    "candidate",
    await createCandidateManifest(),
  );
  baseApproval = approvalPayload();
  baseApproval.targetFingerprint =
    airportDatabaseTargetFingerprint(migrationDatabaseUrl);
  baseApproval.candidateManifestSha256 = candidate.sha256;
  const approvalArtifact = await writeContentAddressedJson(
    approvalDirectory,
    "approval",
    baseApproval,
  );
  baseEnvironment = {
    NODE_ENV: "test",
    MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    AIRPORT_RELEASE_TARGET_APPROVAL_PATH: approvalArtifact.path,
    AIRPORT_RELEASE_TARGET_APPROVAL_SHA256: approvalArtifact.sha256,
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH: candidate.path,
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256: candidate.sha256,
    AIRPORT_RELEASE_CONFIRMATION:
      AIRPORT_RELEASE_CONFIRMATION_PREFIX + approvalArtifact.sha256,
    AIRPORT_RELEASE_EVIDENCE_DIRECTORY: evidenceDirectory,
  };
}, 30_000);

afterAll(async () => {
  await Promise.all([
    rm(approvalDirectory, { recursive: true, force: true }),
    rm(evidenceDirectory, { recursive: true, force: true }),
  ]);
});

function approvedEnvironment(): NodeJS.ProcessEnv {
  return { ...baseEnvironment };
}

async function environmentWithApproval(
  approval: ReturnType<typeof approvalPayload>,
): Promise<NodeJS.ProcessEnv> {
  approval.targetFingerprint = baseApproval.targetFingerprint;
  approval.candidateManifestSha256 =
    baseApproval.candidateManifestSha256;
  const artifact = await writeContentAddressedJson(
    approvalDirectory,
    "approval",
    approval,
  );
  return {
    ...approvedEnvironment(),
    AIRPORT_RELEASE_TARGET_APPROVAL_PATH: artifact.path,
    AIRPORT_RELEASE_TARGET_APPROVAL_SHA256: artifact.sha256,
    AIRPORT_RELEASE_CONFIRMATION:
      AIRPORT_RELEASE_CONFIRMATION_PREFIX + artifact.sha256,
  };
}

describe("airport release database target safety", () => {
  it("uses only the session migration credential for the separately approved target", () => {
    const target = requireAirportReleaseTarget(approvedEnvironment());

    expect(target.databaseName).toBe("flight_map");
    expect(target.databaseOid).toBe(16_384);
    expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an unapproved database before creating a client or writing", async () => {
    const operation = vi.fn();
    const environment = approvedEnvironment();
    environment.MIGRATION_DATABASE_URL = databaseUrl(
      "migration",
      "first-secret",
      "other_database",
    );

    await expect(
      withVerifiedAirportReleaseTarget(environment, operation),
    ).rejects.toMatchObject({
      diagnosticCode: "target-approval-invalid",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a self-derived or stale target/candidate approval", () => {
    const wrongTarget = approvedEnvironment();
    wrongTarget.MIGRATION_DATABASE_URL = databaseUrl(
      "migration",
      "first-secret",
      "other_database",
    );
    expect(() => requireAirportReleaseTarget(wrongTarget)).toThrow(
      expect.objectContaining({ diagnosticCode: "target-approval-invalid" }),
    );

    const staleCandidate = approvedEnvironment();
    staleCandidate.AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256 =
      "0".repeat(64);
    expect(() => requireAirportReleaseTarget(staleCandidate)).toThrow(
      expect.objectContaining({ diagnosticCode: "target-approval-invalid" }),
    );
  });

  it("requires a fresh pause followed by a fresh verified snapshot", async () => {
    const stale = approvalPayload(Date.now() - 31 * 60 * 1000);
    stale.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    stale.changeControl.expiresAt = stale.expiresAt;
    stale.snapshot.expiresAt = stale.expiresAt;
    await expect(
      environmentWithApproval(stale).then((environment) =>
        requireAirportReleaseTarget(environment),
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "target-approval-invalid",
    });

    const misordered = approvalPayload();
    misordered.snapshot.createdAt = new Date(
      Date.parse(misordered.changeControl.importsPausedAt) - 1,
    ).toISOString();
    await expect(
      environmentWithApproval(misordered).then((environment) =>
        requireAirportReleaseTarget(environment),
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "target-approval-invalid",
    });
  });

  it("requires exact rollback stop conditions and verification command", async () => {
    const invalid = approvalPayload();
    invalid.snapshot.restoreProcedure.stopConditions =
      ["promotion-health-failed"] as never;
    invalid.snapshot.restoreProcedureSha256 = sha256Bytes(
      canonicalJson(invalid.snapshot.restoreProcedure),
    );
    await expect(
      environmentWithApproval(invalid).then((environment) =>
        requireAirportReleaseTarget(environment),
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "target-approval-invalid",
    });
  });

  it("requires the exact content-addressed approval confirmation", () => {
    const environment = approvedEnvironment();
    environment.AIRPORT_RELEASE_CONFIRMATION = "yes";
    expect(() => requireAirportReleaseTarget(environment)).toThrow(
      expect.objectContaining({
        diagnosticCode: "operator-confirmation-missing",
      }),
    );
  });

  it("requires production approval to match fresh control-plane and snapshot evidence", async () => {
    const approval = approvalPayload();
    approval.environment = "production";
    approval.targetFingerprint = baseApproval.targetFingerprint;
    approval.candidateManifestSha256 =
      baseApproval.candidateManifestSha256;
    const preflight = await writeContentAddressedJson(
      evidenceDirectory,
      "airport-production-preflight",
      {
        schemaVersion: 3,
        status: "production-preflight-provider-verified",
        authorization: "context-only-fresh-provider-query-required",
        generatedAt: new Date(Date.now() - 500).toISOString(),
        expiresAt: approval.expiresAt,
        releaseControlPlane: {
          deploymentId: "dpl_12345678",
          deploymentUrl: "https://candidate.vercel.app",
          productionAlias: "flight-map-one.vercel.app",
          aliasDeploymentId: "dpl_12345678",
          projectId: "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8",
          orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
          teamSlug: "giffdevs-projects",
          commitSha: "0".repeat(40),
          gitRef: "main",
          gitRepoId: "123456",
          sourceManifestSha256: "1".repeat(64),
          deploymentSourceManifestSha256: "8".repeat(64),
          providerSourceSha256: "9".repeat(64),
          candidateManifestSha256:
            approval.candidateManifestSha256,
          approvedAirportCandidateSha256: "d".repeat(64),
          providerExpectationSha256: "e".repeat(64),
          expectationSha256: "a".repeat(64),
          runtimeClaimsSha256: "b".repeat(64),
          oidcIdentitySha256: "c".repeat(64),
          oidcTokenSha256: "3".repeat(64),
          challengeSha256: "4".repeat(64),
          providerVerificationSha256: "f".repeat(64),
          providerBeforeSha256: "6".repeat(64),
          providerAfterSha256: "7".repeat(64),
          providerRequestStartedAt:
            new Date(Date.now() - 350).toISOString(),
          providerRequestCompletedAt:
            new Date(Date.now() - 300).toISOString(),
          responseSha256: "1".repeat(64),
          runtimeWriteMode: "read-only",
          defaultTransactionReadOnly: "on",
          writesPaused: true,
          verifiedAt: new Date(Date.now() - 250).toISOString(),
        },
        target: {
          fingerprint: approval.targetFingerprint,
          databaseName: approval.databaseName,
          databaseOid: approval.databaseOid,
        },
        migration: {
          manifestSha256: "2".repeat(64),
          boundary: "0014",
        },
        snapshot: {
          id: approval.snapshot.id,
          sha256: approval.snapshot.sha256,
          preChangeStateSha256:
            approval.snapshot.preChangeStateSha256,
          restoreProcedureSha256:
            approval.snapshot.restoreProcedureSha256,
          createdAt: approval.snapshot.createdAt,
          verifiedAt: approval.snapshot.verifiedAt,
          expiresAt: approval.snapshot.expiresAt,
        },
      },
    );
    approval.changeControl.pauseEvidenceSha256 = preflight.sha256;
    const environment = await environmentWithApproval(approval);
    environment.AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256 =
      "d".repeat(64);
    environment.AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH =
      preflight.path;
    environment.AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256 =
      preflight.sha256;

    expect(requireAirportReleaseTarget(environment)).toMatchObject({
      approvedAirportCandidateSha256: "d".repeat(64),
      productionPreflight: {
        status: "production-preflight-provider-verified",
      },
    });

    environment.AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256 =
      "0".repeat(64);
    expect(() => requireAirportReleaseTarget(environment)).toThrow(
      expect.objectContaining({ diagnosticCode: "target-approval-invalid" }),
    );
  });

  it("does not include credentials or connection strings in failures", () => {
    const environment = approvedEnvironment();
    environment.MIGRATION_DATABASE_URL = databaseUrl(
      "migration",
      "secret",
      "one",
    );
    let message = "";
    try {
      requireAirportReleaseTarget(environment);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("secret");
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("db.example.test");
  });

  it("uses deterministic content hashes for approval artifacts", () => {
    const payload = { b: 2, a: 1 };
    expect(sha256Bytes(canonicalJson(payload))).toBe(
      sha256Bytes(canonicalJson({ a: 1, b: 2 })),
    );
  });
});
