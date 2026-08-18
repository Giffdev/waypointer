import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
const FIXED_VERCEL_PROJECT_LINK = {
  projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
  orgId: RELEASE_DEPLOYMENT_TRUST.orgId,
  projectName: RELEASE_DEPLOYMENT_TRUST.projectName,
  settings: {
    framework: "nextjs",
    devCommand: null,
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    rootDirectory: null,
    directoryListing: false,
    nodeVersion: "24.x",
  },
} as const;

interface CommandResult {
  readonly stdout: string;
}

export async function verifyPublicAuthAvailability(
  origin: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  for (const pathname of ["/auth/register", "/auth/sign-in"]) {
    const response = await fetchImplementation(new URL(pathname, origin), {
      redirect: "manual",
      cache: "no-store",
      headers: {
        "cache-control": "no-cache, no-store",
        pragma: "no-cache",
      },
    });
    if (
      response.status !== 200 ||
      (await response.text()).trim().length === 0
    ) {
      throw new Error(`Public auth route is unavailable: ${pathname}`);
    }
  }
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

export function vercelCommandInvocation(
  args: readonly string[],
  platform = process.platform,
  windowsEntryPoint?: string,
): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  if (platform !== "win32") {
    return { executable: "vercel", args };
  }
  const entryPoint =
    windowsEntryPoint ?? resolveWindowsVercelEntryPoint(process.env.PATH ?? "");
  return {
    executable: process.execPath,
    args: [entryPoint, ...args],
  };
}

export function resolveWindowsVercelEntryPoint(pathValue: string): string {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const commandPath = path.join(directory, "vercel.cmd");
    const entryPoint = path.join(
      directory,
      "node_modules",
      "vercel",
      "dist",
      "vc.js",
    );
    if (existsSync(commandPath) && existsSync(entryPoint)) {
      return entryPoint;
    }
  }
  throw new Error("Unable to locate the installed Vercel CLI");
}

export async function runVercel(
  args: readonly string[],
  options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly capture?: boolean;
  },
): Promise<CommandResult> {
  const invocation = vercelCommandInvocation(args);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.args], {
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

export function vercelCliProviderFetch(
  environment: NodeJS.ProcessEnv,
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (
      url.origin !== "https://api.vercel.com" ||
      (init?.method && init.method !== "GET")
    ) {
      return Response.json({ error: "invalid provider request" }, {
        status: 400,
      });
    }
    try {
      const payload = await providerJson<unknown>(
        `${url.pathname}${url.search}`,
        environment,
      );
      return Response.json(payload, { headers: { age: "0" } });
    } catch {
      return Response.json({ error: "provider request failed" }, {
        status: 503,
      });
    }
  }) as typeof fetch;
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
    FLIGHT_MAP_MIGRATION_MANIFEST_SHA256:
      options.migrationManifestSha256,
  };
}

async function writeFixedVercelProjectLink(
  repositoryRoot: string,
): Promise<void> {
  const vercelDirectory = path.join(repositoryRoot, ".vercel");
  const projectPath = path.join(vercelDirectory, "project.json");
  await mkdir(vercelDirectory, { recursive: true });
  await writeFile(
    projectPath,
    `${JSON.stringify(FIXED_VERCEL_PROJECT_LINK)}\n`,
    "utf8",
  );
  assertLinkedVercelProject(
    JSON.parse(await readFile(projectPath, "utf8")) as {
      projectId?: string;
      orgId?: string;
    },
  );
}

async function hideLocalEnvironmentFiles(
  repositoryRoot: string,
): Promise<() => Promise<void>> {
  const hidden: Array<{ source: string; hold: string }> = [];
  try {
    for (const fileName of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]) {
      const source = path.join(repositoryRoot, fileName);
      const hold = path.join(
        repositoryRoot,
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

export async function buildVercelPrebuiltOutput(options: {
  readonly repositoryRoot?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runCli?: typeof runVercel;
}): Promise<void> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? root);
  const runCli = options.runCli ?? runVercel;
  await writeFixedVercelProjectLink(repositoryRoot);
  const providerEnvironmentPath = path.join(
    repositoryRoot,
    ".vercel",
    ".env.production.local",
  );
  const globalConfigDirectory = path.join(
    repositoryRoot,
    ".vercel",
    "release-control-global",
  );
  await rm(providerEnvironmentPath, { force: true });
  await rm(globalConfigDirectory, { recursive: true, force: true });
  const restoreLocalEnvironmentFiles =
    await hideLocalEnvironmentFiles(repositoryRoot);
  try {
    await runCli(
      [
        "build",
        "--prod",
        "--scope",
        RELEASE_DEPLOYMENT_TRUST.teamSlug,
        "--global-config",
        globalConfigDirectory,
      ],
      { environment: options.environment },
    );
    try {
      await access(providerEnvironmentPath);
      throw new Error(
        "Vercel build persisted a production environment file",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  } finally {
    try {
      await Promise.all([
        rm(providerEnvironmentPath, { force: true }),
        rm(globalConfigDirectory, { recursive: true, force: true }),
      ]);
    } finally {
      await restoreLocalEnvironmentFiles();
    }
  }
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
  await verifyPublicAuthAvailability(
    `https://${RELEASE_DEPLOYMENT_TRUST.productionAlias}`,
  );
  if (useExistingPrebuilt) {
    assertLinkedVercelProject(
      JSON.parse(
        await readFile(path.join(root, ".vercel", "project.json"), "utf8"),
      ) as { projectId?: string; orgId?: string },
    );
  } else {
    await buildVercelPrebuiltOutput({
      environment: childEnvironment,
    });
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
