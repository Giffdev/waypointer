import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  loadProviderReleaseExpectation,
  verifyReleaseEndpoint,
} from "./airport-release-health.ts";
import {
  loadAirportReleaseMigrationManifest,
  type UnsafeSqlClient,
  verifyAirportMigrationState,
} from "./airport-release-migrations.ts";
import {
  canonicalJson,
  sha256Bytes,
  verifyCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  AIRPORT_RELEASE_CONFIRMATION_PREFIX,
  airportDatabaseTargetFingerprint,
  requireAirportReleaseTarget,
  requireRepositoryPath,
} from "./airport-release-safety.ts";
import { snapshotAirportReleaseState } from "./airport-release-rollback.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";

const root = path.resolve(import.meta.dirname, "..");
const MAX_AGE_MS = 30 * 60 * 1000;

interface SnapshotAttestation {
  schemaVersion: 1;
  provider: string;
  id: string;
  sha256: string;
  targetFingerprint: string;
  databaseName: string;
  databaseOid: number;
  preChangeStateSha256: string;
  createdAt: string;
  verifiedAt: string;
  expiresAt: string;
  restoreProcedure: {
    schemaVersion: 1;
    stopConditions: [
      "database-release-post-commit-health-failed",
      "deployment-attestation-mismatch",
      "evidence-persistence-failed",
      "promotion-health-failed",
    ];
    transactionSemantics: "serializable-database-release";
    stagingSemantics: "live-production-alias-read-only-control-plane";
    restoreCommand: {
      executable: string;
      args: string[];
    };
    verificationCommand: {
      executable: "npm" | "npm.cmd";
      args: ["run", "db:airport-rollback-verify"];
    };
  };
}

async function readContentAddressedJson<T>(
  filePath: string,
  expectedSha256: string,
): Promise<T> {
  try {
    const bytes = await readFile(filePath);
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      sha256Bytes(bytes) !== expectedSha256
    ) {
      throw new Error("hash");
    }
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
}

function validSnapshotAttestation(
  snapshot: SnapshotAttestation,
  now: number,
): boolean {
  const createdAt = Date.parse(snapshot.createdAt);
  const verifiedAt = Date.parse(snapshot.verifiedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  return Boolean(
    snapshot.schemaVersion === 1 &&
      /^[A-Za-z0-9_.-]{1,64}$/.test(snapshot.provider) &&
      /^[A-Za-z0-9_.:-]{1,256}$/.test(snapshot.id) &&
      /^[a-f0-9]{64}$/.test(snapshot.sha256) &&
      /^[a-f0-9]{64}$/.test(snapshot.targetFingerprint) &&
      snapshot.databaseName &&
      Number.isSafeInteger(snapshot.databaseOid) &&
      snapshot.databaseOid > 0 &&
      /^[a-f0-9]{64}$/.test(snapshot.preChangeStateSha256) &&
      Number.isFinite(createdAt) &&
      Number.isFinite(verifiedAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= verifiedAt &&
      verifiedAt <= now &&
      now - verifiedAt <= MAX_AGE_MS &&
      expiresAt > now &&
      expiresAt - verifiedAt <= MAX_AGE_MS,
  );
}

export function assertCredentialFreeArtifact(
  value: unknown,
  sensitiveValues: string[],
): void {
  const contents = canonicalJson(value);
  if (
    /"(?:databaseUrl|migrationDatabaseUrl|password|token|cookie|authorization)"/i.test(
      contents,
    ) ||
    /postgres(?:ql)?:\/\/|(?:database_url|password)=/i.test(contents) ||
    sensitiveValues.some(
      (sensitive) => sensitive.length > 0 && contents.includes(sensitive),
    )
  ) {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
}

export async function prepareAirportProductionRelease(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const migrationDatabaseUrl =
    environment.MIGRATION_DATABASE_URL?.trim() ?? "";
  if (!migrationDatabaseUrl) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  const candidateManifestPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH,
    path.join("artifacts", "release-evidence", "airport-catalog"),
    ".json",
  );
  const candidateManifestSha256 =
    environment.AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256?.trim() ?? "";
  const approvedAirportCandidateSha256 =
    environment.AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256?.trim() ??
    "";
  const providerExpectationSha256 =
    environment.AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256?.trim() ?? "";
  if (
    !/^[a-f0-9]{64}$/.test(approvedAirportCandidateSha256) ||
    !/^[a-f0-9]{64}$/.test(providerExpectationSha256)
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const candidate = await verifyCandidateManifest(
    candidateManifestPath,
    candidateManifestSha256,
  );
  const deployment = await loadProviderReleaseExpectation(
    environment,
    "control-plane",
  );
  if (
    deployment.candidateManifestSha256 !== candidateManifestSha256 ||
    deployment.sourceManifestSha256 !== candidate.source.manifestSha256 ||
    deployment.deploymentSource.manifestSha256 !==
      candidate.deploymentSource.manifestSha256 ||
    canonicalJson(deployment.deploymentSource.files) !==
      canonicalJson(candidate.deploymentSource.files) ||
    deployment.approvedAirportCandidateSha256 !==
      approvedAirportCandidateSha256
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const pause = await verifyReleaseEndpoint(
    deployment,
    environment.AIRPORT_RELEASE_HEALTH_SESSION_COOKIE?.trim() ?? "",
    {
      vercelApiToken:
        environment.AIRPORT_RELEASE_VERCEL_API_TOKEN?.trim() ?? "",
    },
  );
  const snapshotPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_PATH,
    path.join("data", "private", "release-approvals"),
    ".json",
  );
  const snapshot = await readContentAddressedJson<SnapshotAttestation>(
    snapshotPath,
    environment.AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_SHA256?.trim() ?? "",
  );
  const now = Date.now();
  if (
    !validSnapshotAttestation(snapshot, now) ||
    Date.parse(snapshot.createdAt) < Date.parse(deployment.issuedAt)
  ) {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }

  const targetFingerprint = airportDatabaseTargetFingerprint(
    migrationDatabaseUrl,
  );
  const migrationManifest = await loadAirportReleaseMigrationManifest();
  const client = postgres(migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const [connected] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    const migration = await verifyAirportMigrationState(
      client as unknown as UnsafeSqlClient,
      "production",
    );
    const preChangeState = await snapshotAirportReleaseState(
      client as unknown as UnsafeSqlClient,
      "production",
    );
    if (
      connected.database_name !== snapshot.databaseName ||
      connected.database_oid !== snapshot.databaseOid ||
      targetFingerprint !== snapshot.targetFingerprint ||
      preChangeState.stateSha256 !== snapshot.preChangeStateSha256 ||
      deployment.targetFingerprint !== targetFingerprint ||
      deployment.migrationManifestSha256 !== migrationManifest.sha256 ||
      !["0014", "0015"].includes(migration.boundary)
    ) {
      throw new AirportCatalogSafetyError("database-target-mismatch");
    }
    const expiresAt = new Date(
      Math.min(
        Date.parse(snapshot.expiresAt),
        Date.parse(deployment.expiresAt),
        now + MAX_AGE_MS,
      ),
    ).toISOString();
    const restoreProcedureSha256 = sha256Bytes(
      canonicalJson(snapshot.restoreProcedure),
    );
    const preflight = {
      schemaVersion: 3,
      status: "production-preflight-provider-verified",
      authorization: "context-only-fresh-provider-query-required",
      generatedAt: new Date(now).toISOString(),
      expiresAt,
      releaseControlPlane: {
        deploymentId: deployment.deploymentId,
        deploymentUrl: deployment.deploymentUrl,
        productionAlias: deployment.productionAlias,
        aliasDeploymentId: pause.aliasDeploymentId,
        projectId: deployment.projectId,
        orgId: deployment.orgId,
        teamSlug: deployment.teamSlug,
        commitSha: deployment.gitSource.commitSha,
        gitRef: deployment.gitSource.ref,
        gitRepoId: deployment.gitSource.repoId,
        sourceManifestSha256: deployment.sourceManifestSha256,
        deploymentSourceManifestSha256:
          deployment.deploymentSource.manifestSha256,
        providerSourceSha256: pause.providerSourceSha256,
        candidateManifestSha256,
        approvedAirportCandidateSha256,
        providerExpectationSha256,
        expectationSha256: pause.expectationSha256,
        runtimeClaimsSha256: pause.runtimeClaimsSha256,
        oidcIdentitySha256: pause.oidcIdentitySha256,
        oidcTokenSha256: pause.oidcTokenSha256,
        challengeSha256: pause.challengeSha256,
        providerVerificationSha256: pause.providerVerificationSha256,
        providerBeforeSha256: pause.providerBeforeSha256,
        providerAfterSha256: pause.providerAfterSha256,
        providerRequestStartedAt: pause.providerRequestStartedAt,
        providerRequestCompletedAt: pause.providerRequestCompletedAt,
        responseSha256: pause.responseSha256,
        runtimeWriteMode: "read-only",
        writesPaused: true,
        verifiedAt: pause.verifiedAt,
      },
      target: {
        fingerprint: targetFingerprint,
        databaseName: connected.database_name,
        databaseOid: connected.database_oid,
      },
      migration: {
        manifestSha256: migrationManifest.sha256,
        boundary: migration.boundary as "0014" | "0015",
      },
      snapshot: {
        id: snapshot.id,
        sha256: snapshot.sha256,
        preChangeStateSha256: snapshot.preChangeStateSha256,
        restoreProcedureSha256,
        createdAt: snapshot.createdAt,
        verifiedAt: snapshot.verifiedAt,
        expiresAt,
      },
    } as const;
    const parsedDatabaseUrl = new URL(migrationDatabaseUrl);
    const sensitiveValues = [
      migrationDatabaseUrl,
      decodeURIComponent(parsedDatabaseUrl.username),
      decodeURIComponent(parsedDatabaseUrl.password),
    ];
    assertCredentialFreeArtifact(preflight, sensitiveValues);
    const evidenceDirectory = requireRepositoryPath(
      environment.AIRPORT_RELEASE_EVIDENCE_DIRECTORY,
      path.join("artifacts", "release-evidence", "airport-catalog"),
      undefined,
    );
    const preflightArtifact = await writeContentAddressedJson(
      evidenceDirectory,
      "airport-production-preflight",
      preflight,
    );
    const approval = {
      schemaVersion: 3,
      approvalId: environment.AIRPORT_RELEASE_APPROVAL_ID?.trim(),
      environment: "production",
      targetFingerprint,
      databaseName: connected.database_name,
      databaseOid: connected.database_oid,
      candidateManifestSha256,
      approvedAt: new Date(now).toISOString(),
      expiresAt,
      changeControl: {
        mechanism: "application-read-only-plus-database-barrier",
        staging: "live-production-alias-read-only-control-plane",
        pauseEvidenceSha256: preflightArtifact.sha256,
        importsPausedAt: deployment.issuedAt,
        verifiedAt: pause.verifiedAt,
        expiresAt,
      },
      snapshot: {
        id: snapshot.id,
        sha256: snapshot.sha256,
        preChangeStateSha256: snapshot.preChangeStateSha256,
        restoreProcedureSha256,
        createdAt: snapshot.createdAt,
        verifiedAt: snapshot.verifiedAt,
        expiresAt,
        restoreProcedure: snapshot.restoreProcedure,
      },
    } as const;
    assertCredentialFreeArtifact(approval, sensitiveValues);
    const approvalDirectory = path.join(
      root,
      "data",
      "private",
      "release-approvals",
    );
    const approvalArtifact = await writeContentAddressedJson(
      approvalDirectory,
      "airport-production-target",
      approval,
    );
    requireAirportReleaseTarget({
      ...environment,
      AIRPORT_RELEASE_TARGET_APPROVAL_PATH: approvalArtifact.path,
      AIRPORT_RELEASE_TARGET_APPROVAL_SHA256: approvalArtifact.sha256,
      AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH:
        preflightArtifact.path,
      AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256:
        preflightArtifact.sha256,
      AIRPORT_RELEASE_CONFIRMATION:
        AIRPORT_RELEASE_CONFIRMATION_PREFIX + approvalArtifact.sha256,
    });
    return {
      approvalPath: approvalArtifact.path,
      approvalSha256: approvalArtifact.sha256,
      preflightPath: preflightArtifact.path,
      preflightSha256: preflightArtifact.sha256,
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main() {
  const result = await prepareAirportProductionRelease();
  process.stdout.write(
    JSON.stringify({
      approvalPath: path.relative(root, result.approvalPath),
      approvalSha256: result.approvalSha256,
      preflightPath: path.relative(root, result.preflightPath),
      preflightSha256: result.preflightSha256,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(formatSafePostgresError(error));
    process.exitCode = 1;
  });
}
