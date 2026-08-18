import { createHash } from "node:crypto";

export type ReleasePhase = "control-plane" | "database-released";

export interface ReleaseRuntimeClaims {
  schemaVersion: 5;
  deploymentMethod: "vercel-cli-prebuilt";
  releasePhase: ReleasePhase;
  deploymentId: string;
  deploymentUrl: string;
  projectId: string;
  productionUrl: string;
  environment: "production";
  targetEnvironment: "production";
  gitProvider: "github";
  gitRepoOwner: string;
  gitRepoName: string;
  gitRepoId: string;
  gitCommitRef: string;
  gitCommitSha: string;
  sourceManifestSha256: string;
  deploymentSourceManifestSha256: string;
  candidateManifestSha256: string;
  approvedAirportCandidateSha256: string;
  targetFingerprint: string;
  migrationManifestSha256: string;
  catalogChecksum?: string;
  databaseEvidenceSha256?: string;
  writesPaused: true;
  runtimeClaimsSha256: string;
}

function canonicalJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    null,
    2,
  )}\n`;
}

export function releaseRuntimeClaimsSha256(
  value: Omit<ReleaseRuntimeClaims, "runtimeClaimsSha256">,
): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new Error("Release runtime claims are unavailable.");
  }
  return value;
}

export function releaseRuntimeClaimsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseRuntimeClaims {
  if (
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "production" ||
    environment.VERCEL_TARGET_ENV !== "production" ||
    environment.FLIGHT_MAP_RELEASE_WRITES_PAUSED?.trim() !== "true"
  ) {
    throw new Error("Release runtime claims are unavailable.");
  }
  const releasePhase = required(
    environment,
    "FLIGHT_MAP_RELEASE_PHASE",
    /^(?:control-plane|database-released)$/,
  ) as ReleasePhase;
  const catalogChecksum =
    environment.FLIGHT_MAP_CATALOG_CHECKSUM?.trim() || undefined;
  const databaseEvidenceSha256 =
    environment.FLIGHT_MAP_DATABASE_EVIDENCE_SHA256?.trim() || undefined;
  if (
    (releasePhase === "control-plane" &&
      (catalogChecksum || databaseEvidenceSha256)) ||
    (releasePhase === "database-released" &&
      (!catalogChecksum ||
        !databaseEvidenceSha256 ||
        !/^[a-f0-9]{64}$/.test(catalogChecksum) ||
        !/^[a-f0-9]{64}$/.test(databaseEvidenceSha256)))
  ) {
    throw new Error("Release runtime claims are unavailable.");
  }
  const deploymentHostname = required(
    environment,
    "VERCEL_URL",
    /^[A-Za-z0-9.-]+\.vercel\.app$/,
  ).toLowerCase();
  const core = {
    schemaVersion: 5 as const,
    deploymentMethod: required(
      environment,
      "FLIGHT_MAP_DEPLOYMENT_METHOD",
      /^vercel-cli-prebuilt$/,
    ) as "vercel-cli-prebuilt",
    releasePhase,
    deploymentId: required(
      environment,
      "VERCEL_DEPLOYMENT_ID",
      /^dpl_[A-Za-z0-9]{8,256}$/,
    ),
    deploymentUrl: `https://${deploymentHostname}`,
    projectId: required(
      environment,
      "VERCEL_PROJECT_ID",
      /^prj_[A-Za-z0-9]{8,256}$/,
    ),
    productionUrl: required(
      environment,
      "VERCEL_PROJECT_PRODUCTION_URL",
      /^[A-Za-z0-9.-]+$/,
    ).toLowerCase(),
    environment: "production" as const,
    targetEnvironment: "production" as const,
    gitProvider: required(
      environment,
      "FLIGHT_MAP_GIT_PROVIDER",
      /^github$/,
    ) as "github",
    gitRepoOwner: required(
      environment,
      "FLIGHT_MAP_GIT_REPO_OWNER",
      /^[A-Za-z0-9_.-]{1,100}$/,
    ),
    gitRepoName: required(
      environment,
      "FLIGHT_MAP_GIT_REPO_NAME",
      /^[A-Za-z0-9_.-]{1,100}$/,
    ),
    gitRepoId: required(
      environment,
      "FLIGHT_MAP_GIT_REPO_ID",
      /^[A-Za-z0-9_.:-]{1,128}$/,
    ),
    gitCommitRef: required(
      environment,
      "FLIGHT_MAP_GIT_COMMIT_REF",
      /^[A-Za-z0-9._/-]{1,256}$/,
    ),
    gitCommitSha: required(
      environment,
      "FLIGHT_MAP_GIT_COMMIT_SHA",
      /^[a-f0-9]{40}$/,
    ).toLowerCase(),
    sourceManifestSha256: required(
      environment,
      "FLIGHT_MAP_SOURCE_MANIFEST_SHA256",
      /^[a-f0-9]{64}$/,
    ),
    deploymentSourceManifestSha256: required(
      environment,
      "FLIGHT_MAP_DEPLOYMENT_SOURCE_MANIFEST_SHA256",
      /^[a-f0-9]{64}$/,
    ),
    candidateManifestSha256: required(
      environment,
      "FLIGHT_MAP_CANDIDATE_MANIFEST_SHA256",
      /^[a-f0-9]{64}$/,
    ),
    approvedAirportCandidateSha256: required(
      environment,
      "FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256",
      /^[a-f0-9]{64}$/,
    ),
    targetFingerprint: required(
      environment,
      "FLIGHT_MAP_TARGET_FINGERPRINT",
      /^[a-f0-9]{64}$/,
    ),
    migrationManifestSha256: required(
      environment,
      "FLIGHT_MAP_MIGRATION_MANIFEST_SHA256",
      /^[a-f0-9]{64}$/,
    ),
    ...(releasePhase === "database-released"
      ? { catalogChecksum, databaseEvidenceSha256 }
      : {}),
    writesPaused: true as const,
  };
  return {
    ...core,
    runtimeClaimsSha256: releaseRuntimeClaimsSha256(core),
  };
}
