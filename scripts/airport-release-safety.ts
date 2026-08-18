import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  sha256Bytes,
} from "./airport-release-provenance.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";
import { AIRPORT_RELEASE_LOCK_KEYS } from "../src/lib/db/release-lock.ts";

export const AIRPORT_RELEASE_CONFIRMATION_PREFIX =
  "release-airport-catalog:";
export const AIRPORT_ROLLBACK_CONFIRMATION_PREFIX =
  "rollback-airport-catalog:";
export { AIRPORT_RELEASE_LOCK_KEYS };
export const AIRPORT_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

export const REQUIRED_ROLLBACK_STOP_CONDITIONS = [
  "database-release-post-commit-health-failed",
  "deployment-attestation-mismatch",
  "evidence-persistence-failed",
  "promotion-health-failed",
] as const;

export type AirportRollbackStopCondition =
  (typeof REQUIRED_ROLLBACK_STOP_CONDITIONS)[number];

export interface ApprovedCommand {
  executable: string;
  args: string[];
}

export interface AirportReleaseTargetApproval {
  schemaVersion: 3;
  approvalId: string;
  environment: "production" | "test";
  targetFingerprint: string;
  databaseName: string;
  databaseOid: number;
  candidateManifestSha256: string;
  approvedAt: string;
  expiresAt: string;
  changeControl: {
    mechanism: "application-read-only-plus-database-barrier";
    staging: "live-production-alias-read-only-control-plane";
    pauseEvidenceSha256: string;
    importsPausedAt: string;
    verifiedAt: string;
    expiresAt: string;
  };
  snapshot: {
    id: string;
    sha256: string;
    preChangeStateSha256: string;
    restoreProcedureSha256: string;
    createdAt: string;
    verifiedAt: string;
    expiresAt: string;
    restoreProcedure: {
      schemaVersion: 1;
      stopConditions: AirportRollbackStopCondition[];
      transactionSemantics: "serializable-database-release";
      stagingSemantics: "live-production-alias-read-only-control-plane";
      restoreCommand: ApprovedCommand;
      verificationCommand: ApprovedCommand;
    };
  };
}

export interface AirportProductionPreflightEvidence {
  schemaVersion: 3;
  status: "production-preflight-provider-verified";
  authorization: "context-only-fresh-provider-query-required";
  generatedAt: string;
  expiresAt: string;
  releaseControlPlane: {
    deploymentId: string;
    deploymentUrl: string;
    productionAlias: string;
    aliasDeploymentId: string;
    projectId: string;
    orgId: string;
    teamSlug: string;
    commitSha: string;
    gitRef: string;
    gitRepoId: string;
    sourceManifestSha256: string;
    deploymentSourceManifestSha256: string;
    providerSourceSha256: string;
    candidateManifestSha256: string;
    approvedAirportCandidateSha256: string;
    providerExpectationSha256: string;
    expectationSha256: string;
    runtimeClaimsSha256: string;
    oidcIdentitySha256: string;
    oidcTokenSha256: string;
    challengeSha256: string;
    providerVerificationSha256: string;
    providerBeforeSha256: string;
    providerAfterSha256: string;
    providerRequestStartedAt: string;
    providerRequestCompletedAt: string;
    responseSha256: string;
    runtimeWriteMode: "read-only";
    writesPaused: true;
    verifiedAt: string;
  };
  target: {
    fingerprint: string;
    databaseName: string;
    databaseOid: number;
  };
  migration: {
    manifestSha256: string;
    boundary: "0014" | "0015";
  };
  snapshot: {
    id: string;
    sha256: string;
    preChangeStateSha256: string;
    restoreProcedureSha256: string;
    createdAt: string;
    verifiedAt: string;
    expiresAt: string;
  };
}

export interface AirportReleaseTarget {
  migrationDatabaseUrl: string;
  fingerprint: string;
  databaseName: string;
  databaseOid: number;
  evidenceDirectory: string;
  candidateManifestPath: string;
  candidateManifestSha256: string;
  approvalPath: string;
  approvalSha256: string;
  approval: AirportReleaseTargetApproval;
  approvedAirportCandidateSha256?: string;
  productionPreflight?: AirportProductionPreflightEvidence;
}

interface ParsedDatabaseTarget {
  canonical: string;
  databaseName: string;
}

function parseDatabaseTarget(value: string | undefined): ParsedDatabaseTarget {
  if (!value?.trim()) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(value);
  } catch {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname ||
    !databaseUrl.pathname ||
    databaseUrl.pathname === "/"
  ) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!databaseName || databaseName.includes("/")) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  return {
    canonical:
      `postgresql://${databaseUrl.hostname.toLowerCase()}:` +
      `${databaseUrl.port || "5432"}/${databaseName}`,
    databaseName,
  };
}

export function airportDatabaseTargetFingerprint(databaseUrl: string): string {
  return createHash("sha256")
    .update(parseDatabaseTarget(databaseUrl).canonical)
    .digest("hex");
}

export function requireRepositoryPath(
  value: string | undefined,
  permittedRelativeRoot: string,
  extension: string | undefined,
): string {
  if (!value?.trim()) {
    throw new AirportCatalogSafetyError("evidence-path-invalid");
  }
  const root = process.cwd();
  const resolved = path.resolve(root, value);
  const permittedRoot = path.resolve(root, permittedRelativeRoot);
  if (
    (resolved !== permittedRoot &&
      !resolved.startsWith(`${permittedRoot}${path.sep}`)) ||
    (extension && path.extname(resolved).toLowerCase() !== extension)
  ) {
    throw new AirportCatalogSafetyError("evidence-path-invalid");
  }
  return resolved;
}

function validDate(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function validCommand(command: ApprovedCommand | undefined): boolean {
  return Boolean(
    command &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(command.executable) &&
      Array.isArray(command.args) &&
      command.args.length > 0 &&
      command.args.length <= 32 &&
      command.args.every(
        (argument) =>
          typeof argument === "string" &&
          argument.length > 0 &&
          argument.length <= 256 &&
          !/[\r\n;&|$><]/.test(argument),
      ),
  );
}

function hasExactStopConditions(
  conditions: AirportRollbackStopCondition[] | undefined,
): boolean {
  return Boolean(
    conditions &&
      conditions.length === REQUIRED_ROLLBACK_STOP_CONDITIONS.length &&
      [...conditions].sort().every(
        (condition, index) =>
          condition === [...REQUIRED_ROLLBACK_STOP_CONDITIONS].sort()[index],
      ),
  );
}

function parseApproval(
  approvalPath: string,
  approvalSha256: string,
): AirportReleaseTargetApproval {
  let contents: Buffer;
  let approval: AirportReleaseTargetApproval;
  try {
    contents = readFileSync(approvalPath);
    if (
      !/^[a-f0-9]{64}$/.test(approvalSha256) ||
      sha256Bytes(contents) !== approvalSha256
    ) {
      throw new Error("hash");
    }
    approval = JSON.parse(
      contents.toString("utf8"),
    ) as AirportReleaseTargetApproval;
  } catch {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
  const now = Date.now();
  const approvedAt = validDate(approval.approvedAt);
  const expiresAt = validDate(approval.expiresAt);
  const importsPausedAt = validDate(
    approval.changeControl?.importsPausedAt,
  );
  const pauseVerifiedAt = validDate(
    approval.changeControl?.verifiedAt,
  );
  const pauseExpiresAt = validDate(
    approval.changeControl?.expiresAt,
  );
  const snapshotCreatedAt = validDate(approval.snapshot?.createdAt);
  const snapshotVerifiedAt = validDate(approval.snapshot?.verifiedAt);
  const snapshotExpiresAt = validDate(approval.snapshot?.expiresAt);
  const verification = approval.snapshot?.restoreProcedure
    ?.verificationCommand;
  if (
    approval.schemaVersion !== 3 ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(approval.approvalId) ||
    !["production", "test"].includes(approval.environment) ||
    !/^[a-f0-9]{64}$/.test(approval.targetFingerprint) ||
    !approval.databaseName ||
    !Number.isSafeInteger(approval.databaseOid) ||
    approval.databaseOid <= 0 ||
    !/^[a-f0-9]{64}$/.test(approval.candidateManifestSha256) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    approvedAt > now ||
    expiresAt <= now ||
    approval.changeControl?.mechanism !==
      "application-read-only-plus-database-barrier" ||
    approval.changeControl.staging !==
      "live-production-alias-read-only-control-plane" ||
    !/^[a-f0-9]{64}$/.test(
      approval.changeControl.pauseEvidenceSha256,
    ) ||
    !Number.isFinite(importsPausedAt) ||
    !Number.isFinite(pauseVerifiedAt) ||
    !Number.isFinite(pauseExpiresAt) ||
    importsPausedAt < approvedAt ||
    pauseVerifiedAt < importsPausedAt ||
    pauseVerifiedAt > now ||
    now - pauseVerifiedAt > AIRPORT_SNAPSHOT_MAX_AGE_MS ||
    pauseExpiresAt <= now ||
    pauseExpiresAt > expiresAt ||
    !approval.snapshot ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(approval.snapshot.id) ||
    !/^[a-f0-9]{64}$/.test(approval.snapshot.sha256) ||
    !/^[a-f0-9]{64}$/.test(approval.snapshot.preChangeStateSha256) ||
    !/^[a-f0-9]{64}$/.test(
      approval.snapshot.restoreProcedureSha256,
    ) ||
    approval.snapshot.restoreProcedureSha256 !==
      sha256Bytes(canonicalJson(approval.snapshot.restoreProcedure)) ||
    !Number.isFinite(snapshotCreatedAt) ||
    !Number.isFinite(snapshotVerifiedAt) ||
    !Number.isFinite(snapshotExpiresAt) ||
    snapshotCreatedAt < importsPausedAt ||
    snapshotVerifiedAt < snapshotCreatedAt ||
    snapshotVerifiedAt > now ||
    now - snapshotVerifiedAt > AIRPORT_SNAPSHOT_MAX_AGE_MS ||
    snapshotExpiresAt <= now ||
    snapshotExpiresAt > expiresAt ||
    approval.snapshot.restoreProcedure?.schemaVersion !== 1 ||
    !hasExactStopConditions(
      approval.snapshot.restoreProcedure.stopConditions,
    ) ||
    approval.snapshot.restoreProcedure.transactionSemantics !==
      "serializable-database-release" ||
    approval.snapshot.restoreProcedure.stagingSemantics !==
      "live-production-alias-read-only-control-plane" ||
    !validCommand(approval.snapshot.restoreProcedure.restoreCommand) ||
    !approval.snapshot.restoreProcedure.restoreCommand.args.includes(
      approval.snapshot.id,
    ) ||
    !validCommand(verification) ||
    !["npm", "npm.cmd"].includes(verification.executable) ||
    canonicalJson(verification.args) !==
      canonicalJson(["run", "db:airport-rollback-verify"])
  ) {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
  return approval;
}

function parseProductionPreflight(
  environment: NodeJS.ProcessEnv,
  approval: AirportReleaseTargetApproval,
  approvalTarget: ParsedDatabaseTarget,
): {
  approvedAirportCandidateSha256: string;
  preflight: AirportProductionPreflightEvidence;
} {
  const preflightPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_PATH,
    path.join("artifacts", "release-evidence", "airport-catalog"),
    ".json",
  );
  const expectedSha256 =
    environment.AIRPORT_RELEASE_PRODUCTION_PREFLIGHT_SHA256?.trim() ?? "";
  const approvedAirportCandidateSha256 =
    environment.AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256?.trim() ??
    "";
  let preflight: AirportProductionPreflightEvidence;
  let contents: Buffer;
  try {
    contents = readFileSync(preflightPath);
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      sha256Bytes(contents) !== expectedSha256 ||
      approval.changeControl.pauseEvidenceSha256 !== expectedSha256 ||
      !/^[a-f0-9]{64}$/.test(approvedAirportCandidateSha256)
    ) {
      throw new Error("hash");
    }
    preflight = JSON.parse(
      contents.toString("utf8"),
    ) as AirportProductionPreflightEvidence;
  } catch {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
  const now = Date.now();
  const generatedAt = validDate(preflight.generatedAt);
  const expiresAt = validDate(preflight.expiresAt);
  const pauseVerifiedAt = validDate(
    preflight.releaseControlPlane?.verifiedAt,
  );
  const providerRequestStartedAt = validDate(
    preflight.releaseControlPlane?.providerRequestStartedAt,
  );
  const providerRequestCompletedAt = validDate(
    preflight.releaseControlPlane?.providerRequestCompletedAt,
  );
  const snapshotCreatedAt = validDate(preflight.snapshot?.createdAt);
  if (
    preflight.schemaVersion !== 3 ||
    preflight.status !== "production-preflight-provider-verified" ||
    preflight.authorization !==
      "context-only-fresh-provider-query-required" ||
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(pauseVerifiedAt) ||
    !Number.isFinite(providerRequestStartedAt) ||
    !Number.isFinite(providerRequestCompletedAt) ||
    generatedAt > now ||
    pauseVerifiedAt > now ||
    now - pauseVerifiedAt > AIRPORT_SNAPSHOT_MAX_AGE_MS ||
    expiresAt <= now ||
    expiresAt > validDate(approval.expiresAt) ||
    preflight.releaseControlPlane.writesPaused !== true ||
    preflight.releaseControlPlane.runtimeWriteMode !== "read-only" ||
    !/^dpl_[A-Za-z0-9]{8,256}$/.test(
      preflight.releaseControlPlane.deploymentId,
    ) ||
    preflight.releaseControlPlane.aliasDeploymentId !==
      preflight.releaseControlPlane.deploymentId ||
    preflight.releaseControlPlane.productionAlias !==
      "flight-map-one.vercel.app" ||
    preflight.releaseControlPlane.projectId !==
      "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8" ||
    preflight.releaseControlPlane.orgId !==
      "team_qymLK9gugmE5lSs2mxC5XqRY" ||
    preflight.releaseControlPlane.teamSlug !== "giffdevs-projects" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
      preflight.releaseControlPlane.commitSha,
    ) ||
    !/^[A-Za-z0-9._/-]{1,256}$/.test(
      preflight.releaseControlPlane.gitRef,
    ) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(
      preflight.releaseControlPlane.gitRepoId,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.sourceManifestSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.deploymentSourceManifestSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.providerSourceSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.providerExpectationSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.expectationSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.runtimeClaimsSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.oidcIdentitySha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.oidcTokenSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.challengeSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.providerVerificationSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.responseSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.providerBeforeSha256,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      preflight.releaseControlPlane.providerAfterSha256,
    ) ||
    providerRequestStartedAt > providerRequestCompletedAt ||
    providerRequestCompletedAt > pauseVerifiedAt ||
    pauseVerifiedAt - providerRequestCompletedAt > 5_000 ||
    preflight.releaseControlPlane.candidateManifestSha256 !==
      approval.candidateManifestSha256 ||
    preflight.releaseControlPlane.approvedAirportCandidateSha256 !==
      approvedAirportCandidateSha256 ||
    preflight.target.fingerprint !== approval.targetFingerprint ||
    preflight.target.databaseName !== approvalTarget.databaseName ||
    preflight.target.databaseOid !== approval.databaseOid ||
    !["0014", "0015"].includes(preflight.migration.boundary) ||
    !/^[a-f0-9]{64}$/.test(preflight.migration.manifestSha256) ||
    preflight.snapshot.id !== approval.snapshot.id ||
    preflight.snapshot.sha256 !== approval.snapshot.sha256 ||
    preflight.snapshot.preChangeStateSha256 !==
      approval.snapshot.preChangeStateSha256 ||
    preflight.snapshot.restoreProcedureSha256 !==
      approval.snapshot.restoreProcedureSha256 ||
    preflight.snapshot.createdAt !== approval.snapshot.createdAt ||
    preflight.snapshot.verifiedAt !== approval.snapshot.verifiedAt ||
    preflight.snapshot.expiresAt !== approval.snapshot.expiresAt ||
    !Number.isFinite(snapshotCreatedAt) ||
    snapshotCreatedAt < validDate(approval.changeControl.importsPausedAt)
  ) {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
  return { approvedAirportCandidateSha256, preflight };
}

export function requireAirportReleaseTarget(
  environment: NodeJS.ProcessEnv = process.env,
): AirportReleaseTarget {
  const migrationDatabaseUrl = environment.MIGRATION_DATABASE_URL?.trim();
  const migrationTarget = parseDatabaseTarget(migrationDatabaseUrl);
  const fingerprint = airportDatabaseTargetFingerprint(
    migrationDatabaseUrl!,
  );
  const approvalPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_TARGET_APPROVAL_PATH,
    path.join("data", "private", "release-approvals"),
    ".json",
  );
  const approvalSha256 =
    environment.AIRPORT_RELEASE_TARGET_APPROVAL_SHA256?.trim() ?? "";
  const approval = parseApproval(approvalPath, approvalSha256);
  const candidateManifestPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH,
    path.join("artifacts", "release-evidence", "airport-catalog"),
    ".json",
  );
  const candidateManifestSha256 =
    environment.AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256?.trim() ?? "";
  if (
    approval.targetFingerprint !== fingerprint ||
    approval.databaseName !== migrationTarget.databaseName ||
    approval.candidateManifestSha256 !== candidateManifestSha256
  ) {
    throw new AirportCatalogSafetyError("target-approval-invalid");
  }
  if (
    environment.AIRPORT_RELEASE_CONFIRMATION?.trim() !==
    `${AIRPORT_RELEASE_CONFIRMATION_PREFIX}${approvalSha256}`
  ) {
    throw new AirportCatalogSafetyError("operator-confirmation-missing");
  }
  const production =
    approval.environment === "production"
      ? parseProductionPreflight(
          environment,
          approval,
          migrationTarget,
        )
      : undefined;
  return {
    migrationDatabaseUrl: migrationDatabaseUrl!,
    fingerprint,
    databaseName: migrationTarget.databaseName,
    databaseOid: approval.databaseOid,
    evidenceDirectory: requireRepositoryPath(
      environment.AIRPORT_RELEASE_EVIDENCE_DIRECTORY,
      path.join("artifacts", "release-evidence", "airport-catalog"),
      undefined,
    ),
    candidateManifestPath,
    candidateManifestSha256,
    approvalPath,
    approvalSha256,
    approval,
    approvedAirportCandidateSha256:
      production?.approvedAirportCandidateSha256,
    productionPreflight: production?.preflight,
  };
}

export async function withVerifiedAirportReleaseTarget<T>(
  environment: NodeJS.ProcessEnv,
  operation: (target: AirportReleaseTarget) => Promise<T>,
): Promise<T> {
  return operation(requireAirportReleaseTarget(environment));
}
