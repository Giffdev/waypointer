import { spawn } from "node:child_process";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  createCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import { loadAirportReleaseMigrationManifest } from "./airport-release-migrations.ts";
import {
  createProviderReleaseExpectation,
  resolveCleanGitSource,
} from "./create-vercel-provider-expectation.ts";
import { RELEASE_DEPLOYMENT_TRUST } from "./vercel-provider-proof.ts";
import {
  createVercelPrebuiltArtifactManifest,
  type VercelPrebuiltDryRun,
  writeVercelPrebuiltArtifactManifest,
} from "./vercel-prebuilt-artifact.ts";

const root = path.resolve(import.meta.dirname, "..");
const REQUIRED_VERCEL_CLI_VERSION = "58.9.2";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

interface CommandResult {
  readonly stdout: string;
}

interface VercelEnvironmentVariable {
  readonly id?: string;
  readonly key?: string;
  readonly target?: string[];
  readonly value?: string;
}

interface VercelEnvironmentResponse {
  readonly envs?: VercelEnvironmentVariable[];
}

interface VercelAliasResponse {
  readonly alias?: string;
  readonly deploymentId?: string;
  readonly projectId?: string;
  readonly redirect?: string | null;
}

export interface ProductionDeploymentOutput {
  readonly id: string;
  readonly url: string;
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function sanitizedDeploymentEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.MIGRATION_DATABASE_URL;
  delete sanitized.DIRECT_DATABASE_URL;
  delete sanitized.POSTGRES_URL;
  delete sanitized.POSTGRES_PRISMA_URL;
  sanitized.DATABASE_URL =
    "postgresql:" +
    "//flight_map_build:flight_map_build@127.0.0.1:5432/flight_map_build";
  sanitized.AUTH_URL = `https://${RELEASE_DEPLOYMENT_TRUST.productionAlias}`;
  sanitized.AUTH_SECRET =
    "flight-map-vercel-build-only-secret-32-characters";
  sanitized.NEXTAUTH_URL = `https://${RELEASE_DEPLOYMENT_TRUST.productionAlias}`;
  sanitized.NEXTAUTH_SECRET =
    "flight-map-vercel-build-only-secret-32-characters";
  sanitized.VERCEL_ORG_ID = RELEASE_DEPLOYMENT_TRUST.orgId;
  sanitized.VERCEL_PROJECT_ID = RELEASE_DEPLOYMENT_TRUST.projectId;
  return sanitized;
}

export function parseProductionDeploymentOutput(
  output: string,
): ProductionDeploymentOutput {
  let parsed: { id?: unknown; deploymentId?: unknown; url?: unknown };
  try {
    parsed = JSON.parse(output.trim()) as typeof parsed;
  } catch {
    throw new Error("Vercel deploy did not return valid JSON");
  }
  const id =
    typeof parsed.id === "string"
      ? parsed.id
      : typeof parsed.deploymentId === "string"
        ? parsed.deploymentId
        : "";
  const rawUrl = typeof parsed.url === "string" ? parsed.url : "";
  const url = rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`;
  if (
    !/^dpl_[A-Za-z0-9]{8,256}$/u.test(id) ||
    !/^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/u.test(url)
  ) {
    throw new Error("Vercel deploy response is missing immutable metadata");
  }
  return { id, url: url.toLowerCase() };
}

export function parseVercelCliVersion(output: string): string {
  const matches = output.match(/\b\d+\.\d+\.\d+\b/gu) ?? [];
  const versions = [...new Set(matches)];
  if (versions.length !== 1) {
    throw new Error("Unable to determine exact Vercel CLI version");
  }
  return versions[0]!;
}

export function assertPinnedVercelCliVersion(output: string): void {
  if (parseVercelCliVersion(output) !== REQUIRED_VERCEL_CLI_VERSION) {
    throw new Error(
      `Vercel CLI ${REQUIRED_VERCEL_CLI_VERSION} is required`,
    );
  }
}

export function parseVercelPrebuiltDryRun(
  output: string,
): VercelPrebuiltDryRun {
  let parsed: {
    fileCount?: unknown;
    files?: Array<{ path?: unknown; size?: unknown; sha?: unknown }>;
  };
  try {
    parsed = JSON.parse(output.trim()) as typeof parsed;
  } catch {
    throw new Error("Vercel dry-run did not return valid JSON");
  }
  if (
    !Number.isSafeInteger(parsed.fileCount) ||
    !Array.isArray(parsed.files) ||
    parsed.fileCount !== parsed.files.length ||
    parsed.files.some(
      (file) =>
        typeof file.path !== "string" ||
        !Number.isSafeInteger(file.size) ||
        typeof file.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(file.sha),
    )
  ) {
    throw new Error("Vercel dry-run file inventory is invalid");
  }
  return parsed as VercelPrebuiltDryRun;
}

export function assertLinkedVercelProject(project: {
  readonly projectId?: string;
  readonly orgId?: string;
}): void {
  if (
    project.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    project.orgId !== RELEASE_DEPLOYMENT_TRUST.orgId
  ) {
    throw new Error("Local Vercel project linkage does not match Waypointer");
  }
}

export function validVercelEnvironmentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,256}$/u.test(value);
}

export async function runVercel(
  args: readonly string[],
  options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly capture?: boolean;
  },
): Promise<CommandResult> {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : "vercel";
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", "vercel", ...args]
    : [...args];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: options.environment,
      windowsHide: true,
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => reject(new Error("Unable to start Vercel CLI")));
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Vercel CLI command failed${
              options.capture && stderr.trim()
                ? `: ${stderr.trim().slice(0, 400)}`
                : ""
            }`,
          ),
        );
        return;
      }
      resolve({ stdout });
    });
  });
}

export async function providerJson<T>(
  providerPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<T> {
  const result = await runVercel(["api", providerPath, "--raw"], {
    environment,
    capture: true,
  });
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error("Vercel API returned invalid JSON");
  }
}

async function verifyWritePause(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const envPath =
    `/v10/projects/${RELEASE_DEPLOYMENT_TRUST.projectId}/env` +
    `?teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}`;
  const response = await providerJson<VercelEnvironmentResponse>(
    envPath,
    environment,
  );
  const matches = (response.envs ?? []).filter(
    (entry) =>
      entry.key === "FLIGHT_MAP_RELEASE_WRITES_PAUSED" &&
      entry.target?.includes("production"),
  );
  if (
    matches.length !== 1 ||
    !validVercelEnvironmentId(matches[0]?.id ?? "")
  ) {
    throw new Error("Production write pause is not uniquely configured");
  }
  const pause = await providerJson<VercelEnvironmentVariable>(
    `/v10/projects/${RELEASE_DEPLOYMENT_TRUST.projectId}/env/` +
      `${matches[0]!.id}?teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}&decrypt=true`,
    environment,
  );
  if (
    pause.key !== "FLIGHT_MAP_RELEASE_WRITES_PAUSED" ||
    pause.value !== "true" ||
    !pause.target?.includes("production")
  ) {
    throw new Error("Production write pause is not exactly true");
  }
}

async function loadPriorAliasOwner(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const alias = await providerJson<VercelAliasResponse>(
    `/v4/aliases/${RELEASE_DEPLOYMENT_TRUST.productionAlias}` +
      `?teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}` +
      `&projectId=${RELEASE_DEPLOYMENT_TRUST.projectId}`,
    environment,
  );
  if (
    alias.alias !== RELEASE_DEPLOYMENT_TRUST.productionAlias ||
    alias.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    alias.redirect != null ||
    !/^dpl_[A-Za-z0-9]{8,256}$/u.test(alias.deploymentId ?? "")
  ) {
    throw new Error("Production alias ownership is invalid");
  }
  return alias.deploymentId!;
}

async function readApprovedAirportCandidate(): Promise<string> {
  const config = JSON.parse(
    await readFile(
      path.join(root, "config", "airport-catalog-release.json"),
      "utf8",
    ),
  ) as {
    provenance?: { approvedAirportCandidate?: { sha256?: unknown } };
  };
  const value = config.provenance?.approvedAirportCandidate?.sha256;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("Approved airport candidate configuration is invalid");
  }
  return value;
}

function deploymentRuntimeVariables(options: {
  readonly gitCommitSha: string;
  readonly candidateManifestSha256: string;
  readonly sourceManifestSha256: string;
  readonly deploymentSourceManifestSha256: string;
  readonly approvedAirportCandidateSha256: string;
  readonly migrationManifestSha256: string;
  readonly targetFingerprint: string;
}): Readonly<Record<string, string>> {
  return {
    FLIGHT_MAP_DEPLOYMENT_METHOD: "vercel-cli-prebuilt",
    FLIGHT_MAP_RELEASE_PHASE: "control-plane",
    FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
    FLIGHT_MAP_GIT_PROVIDER: RELEASE_DEPLOYMENT_TRUST.gitProvider,
    FLIGHT_MAP_GIT_REPO_OWNER: RELEASE_DEPLOYMENT_TRUST.gitRepoOwner,
    FLIGHT_MAP_GIT_REPO_NAME: RELEASE_DEPLOYMENT_TRUST.gitRepoName,
    FLIGHT_MAP_GIT_REPO_ID: RELEASE_DEPLOYMENT_TRUST.gitRepoId,
    FLIGHT_MAP_GIT_COMMIT_REF: RELEASE_DEPLOYMENT_TRUST.gitRef,
    FLIGHT_MAP_GIT_COMMIT_SHA: options.gitCommitSha,
    FLIGHT_MAP_SOURCE_MANIFEST_SHA256: options.sourceManifestSha256,
    FLIGHT_MAP_DEPLOYMENT_SOURCE_MANIFEST_SHA256:
      options.deploymentSourceManifestSha256,
    FLIGHT_MAP_CANDIDATE_MANIFEST_SHA256:
      options.candidateManifestSha256,
    FLIGHT_MAP_APPROVED_AIRPORT_CANDIDATE_SHA256:
      options.approvedAirportCandidateSha256,
    FLIGHT_MAP_TARGET_FINGERPRINT: options.targetFingerprint,
    FLIGHT_MAP_MIGRATION_MANIFEST_SHA256:
      options.migrationManifestSha256,
  };
}

async function writeSafeVercelBuildEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const filePath = path.join(root, ".vercel", ".env.production.local");
  const safeValues = {
    AUTH_SECRET: environment.AUTH_SECRET!,
    AUTH_URL: environment.AUTH_URL!,
    DATABASE_URL: environment.DATABASE_URL!,
    NEXTAUTH_SECRET: environment.NEXTAUTH_SECRET!,
    NEXTAUTH_URL: environment.NEXTAUTH_URL!,
    FLIGHT_MAP_BUILD_ID: environment.FLIGHT_MAP_BUILD_ID!,
  };
  await writeFile(
    filePath,
    `${Object.entries(safeValues)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

async function hideLocalEnvironmentFiles(): Promise<() => Promise<void>> {
  const hidden: Array<{ source: string; hold: string }> = [];
  try {
    for (const fileName of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]) {
      const source = path.join(root, fileName);
      const hold = path.join(
        root,
        ".vercel",
        `${fileName.slice(1)}.release-control-hold`,
      );
      try {
        await access(hold);
        throw new Error(`Environment hold path already exists: ${fileName}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      try {
        await rename(source, hold);
        hidden.push({ source, hold });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    for (const entry of hidden.reverse()) {
      await rename(entry.hold, entry.source);
    }
    throw error;
  }

  return async () => {
    for (const entry of hidden.reverse()) {
      await rename(entry.hold, entry.source);
    }
  };
}

export async function deployProductionCandidate(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const prepareOnly = environment.FLIGHT_MAP_DEPLOY_PREPARE_ONLY === "true";
  const useExistingPrebuilt =
    environment.FLIGHT_MAP_USE_EXISTING_PREBUILT === "true";
  const approvedCommitSha = required(
    environment,
    "FLIGHT_MAP_APPROVED_COMMIT_SHA",
    SHA_PATTERN,
  );
  const approvedCandidateManifestSha256 = required(
    environment,
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256",
    SHA256_PATTERN,
  );
  const childEnvironment = sanitizedDeploymentEnvironment(environment);

  const version = await runVercel(["--version"], {
    environment: childEnvironment,
    capture: true,
  });
  assertPinnedVercelCliVersion(version.stdout);
  const git = await resolveCleanGitSource();
  if (git.commitSha !== approvedCommitSha) {
    throw new Error("Checked-out commit does not match the reviewed commit");
  }
  childEnvironment.FLIGHT_MAP_BUILD_ID = git.commitSha;

  const candidate = await createCandidateManifest();
  const candidateArtifact = await writeContentAddressedJson(
    path.join(root, "artifacts", "release-evidence", "airport-catalog"),
    "candidate",
    candidate,
  );
  if (candidateArtifact.sha256 !== approvedCandidateManifestSha256) {
    throw new Error("Candidate manifest does not match the reviewed candidate");
  }

  await verifyWritePause(childEnvironment);
  const priorAliasDeploymentId =
    await loadPriorAliasOwner(childEnvironment);
  if (useExistingPrebuilt) {
    assertLinkedVercelProject(
      JSON.parse(
        await readFile(path.join(root, ".vercel", "project.json"), "utf8"),
      ) as { projectId?: string; orgId?: string },
    );
  } else {
    await runVercel(
      [
        "pull",
        "--yes",
        "--environment=production",
        "--scope",
        RELEASE_DEPLOYMENT_TRUST.teamSlug,
      ],
      { environment: childEnvironment },
    );
    assertLinkedVercelProject(
      JSON.parse(
        await readFile(path.join(root, ".vercel", "project.json"), "utf8"),
      ) as { projectId?: string; orgId?: string },
    );
    const safeBuildEnvironmentPath =
      await writeSafeVercelBuildEnvironment(childEnvironment);
    const restoreLocalEnvironmentFiles =
      await hideLocalEnvironmentFiles();
    try {
      await runVercel(
        [
          "build",
          "--prod",
          "--yes",
          "--scope",
          RELEASE_DEPLOYMENT_TRUST.teamSlug,
        ],
        { environment: childEnvironment },
      );
    } finally {
      try {
        await restoreLocalEnvironmentFiles();
      } finally {
        await rm(safeBuildEnvironmentPath, { force: true });
      }
    }
  }

  const dryRun = parseVercelPrebuiltDryRun(
    (
      await runVercel(
        [
          "deploy",
          "--prebuilt",
          "--prod",
          "--skip-domain",
          "--dry",
          "--json",
          "--scope",
          RELEASE_DEPLOYMENT_TRUST.teamSlug,
        ],
        { environment: childEnvironment, capture: true },
      )
    ).stdout,
  );
  const prebuiltArtifact = await createVercelPrebuiltArtifactManifest({
    repositoryRoot: root,
    sourceCommitSha: git.commitSha,
    candidateManifestSha256: candidateArtifact.sha256,
    dryRun,
  });
  const prebuiltArtifactPath =
    await writeVercelPrebuiltArtifactManifest(prebuiltArtifact, {
      repositoryRoot: root,
    });
  const preparation = {
    status: "PREPARED",
    deploymentMethod: "vercel-cli-prebuilt",
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    orgId: RELEASE_DEPLOYMENT_TRUST.orgId,
    sourceCommitSha: git.commitSha,
    candidateManifestPath: path.relative(root, candidateArtifact.path),
    candidateManifestSha256: candidateArtifact.sha256,
    sourceManifestSha256: candidate.source.manifestSha256,
    deploymentSourceManifestSha256:
      candidate.deploymentSource.manifestSha256,
    prebuiltArtifactManifestPath: path.relative(
      root,
      prebuiltArtifactPath,
    ),
    prebuiltArtifactManifestSha256: prebuiltArtifact.manifestSha256,
    priorAliasDeploymentId,
    writesPaused: true,
    migrationDatabaseAccessed: false,
  };
  if (prepareOnly) {
    return preparation;
  }
  const approvedPrebuiltArtifactManifestSha256 = required(
    environment,
    "FLIGHT_MAP_APPROVED_PREBUILT_ARTIFACT_MANIFEST_SHA256",
    SHA256_PATTERN,
  );
  if (
    prebuiltArtifact.manifestSha256 !==
    approvedPrebuiltArtifactManifestSha256
  ) {
    throw new Error(
      "Prebuilt artifact does not match the independently reviewed artifact",
    );
  }

  const targetFingerprint = required(
    environment,
    "FLIGHT_MAP_TARGET_FINGERPRINT",
    SHA256_PATTERN,
  );
  const migrationManifest = await loadAirportReleaseMigrationManifest();
  const approvedAirportCandidateSha256 =
    await readApprovedAirportCandidate();
  const runtimeVariables = deploymentRuntimeVariables({
    gitCommitSha: git.commitSha,
    candidateManifestSha256: candidateArtifact.sha256,
    sourceManifestSha256: candidate.source.manifestSha256,
    deploymentSourceManifestSha256:
      candidate.deploymentSource.manifestSha256,
    approvedAirportCandidateSha256,
    migrationManifestSha256: migrationManifest.sha256,
    targetFingerprint,
  });
  const runtimeArguments = Object.entries(runtimeVariables).flatMap(
    ([key, value]) => ["--env", `${key}=${value}`],
  );
  const deployResult = await runVercel(
    [
      "deploy",
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--yes",
      "--format=json",
      "--scope",
      RELEASE_DEPLOYMENT_TRUST.teamSlug,
      ...runtimeArguments,
    ],
    { environment: childEnvironment, capture: true },
  );
  const deployment = parseProductionDeploymentOutput(deployResult.stdout);
  if (deployment.id === priorAliasDeploymentId) {
    throw new Error("Vercel did not create a distinct immutable candidate");
  }

  const expectation = await createProviderReleaseExpectation({
    ...environment,
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH: path.relative(
      root,
      candidateArtifact.path,
    ),
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256: candidateArtifact.sha256,
    FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_PATH: path.relative(
      root,
      prebuiltArtifactPath,
    ),
    FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_SHA256:
      prebuiltArtifact.manifestSha256,
    FLIGHT_MAP_APPROVED_COMMIT_SHA: git.commitSha,
    FLIGHT_MAP_RELEASE_PHASE: "control-plane",
    AIRPORT_RELEASE_DEPLOYMENT_ID: deployment.id,
    AIRPORT_RELEASE_DEPLOYMENT_URL: deployment.url,
    AIRPORT_RELEASE_PRIOR_ALIAS_DEPLOYMENT_ID:
      priorAliasDeploymentId,
    AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256:
      approvedAirportCandidateSha256,
    FLIGHT_MAP_TARGET_FINGERPRINT: targetFingerprint,
    FLIGHT_MAP_MIGRATION_MANIFEST_SHA256:
      migrationManifest.sha256,
  });
  const expectationArtifact = await writeContentAddressedJson(
    path.join(root, "data", "private", "release-approvals"),
    "vercel-provider-expectation",
    expectation,
  );
  const deploymentEvidence = await writeContentAddressedJson(
    path.join(root, "artifacts", "release-evidence", "vercel-deployment"),
    "production-candidate",
    {
      ...preparation,
      status: "DEPLOYED_IMMUTABLE_CANDIDATE",
      deploymentId: deployment.id,
      immutableUrl: deployment.url,
      providerExpectationPath: path.relative(
        root,
        expectationArtifact.path,
      ),
      providerExpectationSha256: expectationArtifact.sha256,
      targetFingerprintConfigured: true,
      aliasChanged: false,
    },
  );
  return {
    ...preparation,
    status: "DEPLOYED_IMMUTABLE_CANDIDATE",
    deploymentId: deployment.id,
    immutableUrl: deployment.url,
    providerExpectationPath: path.relative(
      root,
      expectationArtifact.path,
    ),
    providerExpectationSha256: expectationArtifact.sha256,
    deploymentEvidencePath: path.relative(
      root,
      deploymentEvidence.path,
    ),
    deploymentEvidenceSha256: deploymentEvidence.sha256,
    aliasChanged: false,
  };
}

async function main() {
  const result = await deployProductionCandidate();
  console.log(canonicalJson(result).trim());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
