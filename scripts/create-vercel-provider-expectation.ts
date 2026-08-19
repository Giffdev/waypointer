import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  loadCandidateManifestArtifact,
  verifyCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  detectVercelProviderDeploymentMode,
  providerReleaseExpectationSha256,
  RELEASE_DEPLOYMENT_TRUST,
  sourceArchiveProviderParts,
  sourceBuildEventEvidence,
  verifyProviderSourceArchiveContents,
  type ProviderSourceArchivePart,
  type VercelAliasResponse,
  type VercelBuildEvent,
  type VercelDeploymentResponse,
  type VercelFileTreeEntry,
  type VercelFileContentsResponse,
  type ProviderReleaseExpectationCore,
  type ProviderReleaseExpectation,
} from "./vercel-provider-proof.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";
import { loadVercelPrebuiltArtifactManifest } from "./vercel-prebuilt-artifact.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");

export interface CleanGitSource {
  commitSha: string;
  ref: string;
}

export type GitRunner = (args: string[]) => Promise<string>;

export interface AuthoritativeProviderInspection {
  aliasBefore: VercelAliasResponse;
  aliasAfter: VercelAliasResponse;
  deployment: VercelDeploymentResponse;
  deploymentByHost: VercelDeploymentResponse;
  files: VercelFileTreeEntry[];
  events: VercelBuildEvent[];
  archiveParts?: ProviderSourceArchivePart[];
}

export type ProviderInspectionLoader = (
  environment: NodeJS.ProcessEnv,
  deploymentId: string,
  deploymentUrl: string,
) => Promise<AuthoritativeProviderInspection>;
export type ProviderJsonLoader = <T>(
  providerPath: string,
  environment: NodeJS.ProcessEnv,
) => Promise<T>;

export interface ProviderExpectationDependencies {
  readonly verifyCandidate?: typeof verifyCandidateManifest;
  readonly loadCandidate?: typeof loadCandidateManifestArtifact;
  readonly loadPrebuilt?: typeof loadVercelPrebuiltArtifactManifest;
  readonly loadProvider?: ProviderInspectionLoader;
}

async function defaultGitRunner(args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

export async function loadAuthoritativeProviderInspection(
  environment: NodeJS.ProcessEnv,
  deploymentId: string,
  deploymentUrl: string,
  loadProviderJson?: ProviderJsonLoader,
): Promise<AuthoritativeProviderInspection> {
  const providerJson =
    loadProviderJson ??
    (await import("./deploy-production.ts")).providerJson;
  const team = `teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}`;
  const project = `projectId=${RELEASE_DEPLOYMENT_TRUST.projectId}`;
  const hostname = new URL(deploymentUrl).hostname;
  const aliasPath =
    `/v4/aliases/${RELEASE_DEPLOYMENT_TRUST.productionAlias}` +
    `?${team}&${project}`;
  const deploymentPath =
    `/v13/deployments/${encodeURIComponent(deploymentId)}` +
    `?${team}&withGitRepoInfo=true`;
  const hostPath =
    `/v13/deployments/${encodeURIComponent(hostname)}` +
    `?${team}&withGitRepoInfo=true`;
  const filesPath =
    `/v6/deployments/${encodeURIComponent(deploymentId)}/files?${team}`;
  const eventsPath =
    `/v3/now/deployments/${encodeURIComponent(deploymentId)}/events` +
    `?direction=backward&follow=&limit=500&${team}`;
  const aliasBefore = await providerJson<VercelAliasResponse>(
    aliasPath,
    environment,
  );
  const [deployment, deploymentByHost, files] =
    await Promise.all([
      providerJson<VercelDeploymentResponse>(
        deploymentPath,
        environment,
      ),
      providerJson<VercelDeploymentResponse>(hostPath, environment),
      providerJson<VercelFileTreeEntry[]>(filesPath, environment),
    ]);
  const mode = detectVercelProviderDeploymentMode(files);
  const events =
    mode === "source"
      ? await providerJson<VercelBuildEvent[]>(
          eventsPath,
          environment,
        )
      : [];
  const archiveParts =
    mode === "source"
      ? await Promise.all(
          sourceArchiveProviderParts(files).map(
            async ({ sha1 }) => {
              const contents =
                await providerJson<VercelFileContentsResponse>(
                  `/v8/deployments/${encodeURIComponent(
                    deploymentId,
                  )}/files/${encodeURIComponent(sha1)}?${team}`,
                  environment,
                );
              return { uid: sha1, data: contents.data ?? "" };
            },
          ),
        )
      : undefined;
  const aliasAfter = await providerJson<VercelAliasResponse>(
    aliasPath,
    environment,
  );
  return {
    aliasBefore,
    aliasAfter,
    deployment,
    deploymentByHost,
    files,
    events,
    archiveParts,
  };
}

export async function resolveCleanGitSource(
  runGit: GitRunner = defaultGitRunner,
): Promise<CleanGitSource> {
  try {
    const status = await runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const commitSha = (
      await runGit(["rev-parse", "--verify", "HEAD"])
    ).toLowerCase();
    const currentRef = await runGit(["branch", "--show-current"]);
    if (currentRef === "") {
      await runGit([
        "merge-base",
        "--is-ancestor",
        "HEAD",
        `origin/${RELEASE_DEPLOYMENT_TRUST.gitRef}`,
      ]);
    }
    const remote = await runGit(["remote", "get-url", "origin"]);
    const normalizedRemote = remote
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
    if (
      status !== "" ||
      !/^[a-f0-9]{40}$/.test(commitSha) ||
      (currentRef !== "" &&
        currentRef !== RELEASE_DEPLOYMENT_TRUST.gitRef) ||
      normalizedRemote.toLowerCase() !==
        `https://github.com/${RELEASE_DEPLOYMENT_TRUST.gitRepoOwner}/${RELEASE_DEPLOYMENT_TRUST.gitRepoName}`.toLowerCase()
    ) {
      throw new Error("git");
    }
    return { commitSha, ref: RELEASE_DEPLOYMENT_TRUST.gitRef };
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!pattern.test(value)) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  return value;
}

export async function createProviderReleaseExpectation(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  runGit: GitRunner = defaultGitRunner,
  dependencies: ProviderExpectationDependencies = {},
): Promise<ProviderReleaseExpectation> {
  const deploymentId = required(
    environment,
    "AIRPORT_RELEASE_DEPLOYMENT_ID",
    /^dpl_[A-Za-z0-9]{8,256}$/,
  );
  const deploymentUrl = required(
    environment,
    "AIRPORT_RELEASE_DEPLOYMENT_URL",
    /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/,
  ).toLowerCase();
  const approvedCommitSha = required(
    environment,
    "FLIGHT_MAP_APPROVED_COMMIT_SHA",
    /^[a-f0-9]{40}$/,
  );
  const provider = await (
    dependencies.loadProvider ?? loadAuthoritativeProviderInspection
  )(environment, deploymentId, deploymentUrl);
  const deploymentHostname = new URL(deploymentUrl).hostname;
  const deployment = provider.deployment;
  const hostDeployment = provider.deploymentByHost;
  if (
    provider.aliasBefore.alias !==
      RELEASE_DEPLOYMENT_TRUST.productionAlias ||
    provider.aliasAfter.alias !==
      RELEASE_DEPLOYMENT_TRUST.productionAlias ||
    provider.aliasBefore.projectId !==
      RELEASE_DEPLOYMENT_TRUST.projectId ||
    provider.aliasAfter.projectId !==
      RELEASE_DEPLOYMENT_TRUST.projectId ||
    provider.aliasBefore.redirect != null ||
    provider.aliasAfter.redirect != null ||
    provider.aliasBefore.redirectStatusCode != null ||
    provider.aliasAfter.redirectStatusCode != null ||
    deployment.id !== deploymentId ||
    deployment.url !== deploymentHostname ||
    deployment.name !== RELEASE_DEPLOYMENT_TRUST.projectName ||
    deployment.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    deployment.ownerId !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    deployment.team?.id !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    deployment.team.slug !== RELEASE_DEPLOYMENT_TRUST.teamSlug ||
    deployment.target !== RELEASE_DEPLOYMENT_TRUST.environment ||
    deployment.readyState !== "READY" ||
    deployment.gitSource != null ||
    hostDeployment.id !== deployment.id ||
    hostDeployment.url !== deployment.url ||
    hostDeployment.projectId !== deployment.projectId ||
    hostDeployment.ownerId !== deployment.ownerId ||
    hostDeployment.target !== deployment.target ||
    hostDeployment.readyState !== deployment.readyState ||
    hostDeployment.gitSource != null
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const mode = detectVercelProviderDeploymentMode(provider.files);
  const priorAliasDeploymentId = required(
    environment,
    "AIRPORT_RELEASE_PRIOR_ALIAS_DEPLOYMENT_ID",
    /^dpl_[A-Za-z0-9]{8,256}$/,
  );
  const expectedAliasDeploymentId =
    mode === "prebuilt" ? priorAliasDeploymentId : deploymentId;
  if (
    provider.aliasBefore.deploymentId !== expectedAliasDeploymentId ||
    provider.aliasAfter.deploymentId !== expectedAliasDeploymentId
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const candidateManifestPath = required(
    environment,
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH",
    /^artifacts[\\/]+release-evidence[\\/]+airport-catalog[\\/]+.+\.json$/,
  );
  const candidateManifestSha256 = required(
    environment,
    "AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256",
    /^[a-f0-9]{64}$/,
  );
  const git = await resolveCleanGitSource(runGit);
  let candidate;
  let prebuiltArtifact:
    | Awaited<ReturnType<typeof loadVercelPrebuiltArtifactManifest>>
    | undefined;
  if (mode === "prebuilt") {
    candidate = await (
      dependencies.verifyCandidate ?? verifyCandidateManifest
    )(
      path.resolve(root, candidateManifestPath),
      candidateManifestSha256,
    );
    const prebuiltArtifactManifestPath = required(
      environment,
      "FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_PATH",
      /^artifacts[\\/]+release-evidence[\\/]+vercel-prebuilt-artifact[\\/]+.+\.json$/,
    );
    const prebuiltArtifactManifestSha256 = required(
      environment,
      "FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_SHA256",
      /^[a-f0-9]{64}$/,
    );
    prebuiltArtifact = await (
      dependencies.loadPrebuilt ?? loadVercelPrebuiltArtifactManifest
    )(
      path.resolve(root, prebuiltArtifactManifestPath),
      prebuiltArtifactManifestSha256,
    );
    if (
      git.commitSha !== approvedCommitSha ||
      prebuiltArtifact.manifest.sourceCommitSha !== git.commitSha ||
      prebuiltArtifact.manifest.candidateManifestSha256 !==
        candidateManifestSha256
    ) {
      throw new AirportCatalogSafetyError(
        "candidate-provenance-mismatch",
      );
    }
  } else {
    if (
      environment.FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_PATH?.trim() ||
      environment.FLIGHT_MAP_PREBUILT_ARTIFACT_MANIFEST_SHA256?.trim()
    ) {
      throw new AirportCatalogSafetyError(
        "candidate-provenance-mismatch",
      );
    }
    candidate = await (
      dependencies.loadCandidate ?? loadCandidateManifestArtifact
    )(
      path.resolve(root, candidateManifestPath),
      candidateManifestSha256,
    );
    try {
      await runGit([
        "cat-file",
        "-e",
        `${approvedCommitSha}^{commit}`,
      ]);
      await runGit([
        "merge-base",
        "--is-ancestor",
        approvedCommitSha,
        `origin/${RELEASE_DEPLOYMENT_TRUST.gitRef}`,
      ]);
    } catch {
      throw new AirportCatalogSafetyError(
        "candidate-provenance-mismatch",
      );
    }
    const meta = deployment.meta;
    if (
      deployment.source !== "cli" ||
      deployment.buildSkipped !== false ||
      meta?.githubCommitOrg?.toLowerCase() !==
        RELEASE_DEPLOYMENT_TRUST.gitRepoOwner.toLowerCase() ||
      meta.githubCommitRepo?.toLowerCase() !==
        RELEASE_DEPLOYMENT_TRUST.gitRepoName.toLowerCase() ||
      meta.githubCommitRef !== RELEASE_DEPLOYMENT_TRUST.gitRef ||
      meta.githubCommitSha !== approvedCommitSha ||
      !meta.gitRootDirectory ||
      path.posix.isAbsolute(meta.gitRootDirectory) ||
      meta.gitRootDirectory.includes("\\") ||
      meta.gitRootDirectory.split("/").includes("..")
    ) {
      throw new AirportCatalogSafetyError(
        "candidate-provenance-mismatch",
      );
    }
  }
  const releasePhase = required(
    environment,
    "FLIGHT_MAP_RELEASE_PHASE",
    /^(?:control-plane|database-released)$/,
  ) as ProviderReleaseExpectation["releasePhase"];
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
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const issuedAt = now.toISOString();
  const core = {
    schemaVersion: 7 as const,
    platform: RELEASE_DEPLOYMENT_TRUST.platform,
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    orgId: RELEASE_DEPLOYMENT_TRUST.orgId,
    teamSlug: RELEASE_DEPLOYMENT_TRUST.teamSlug,
    projectName: RELEASE_DEPLOYMENT_TRUST.projectName,
    environment: RELEASE_DEPLOYMENT_TRUST.environment,
    productionAlias: RELEASE_DEPLOYMENT_TRUST.productionAlias,
    releasePhase,
    deploymentId,
    deploymentUrl,
    priorAliasDeploymentId,
    sourceCommit: {
      type: RELEASE_DEPLOYMENT_TRUST.gitProvider,
      owner: RELEASE_DEPLOYMENT_TRUST.gitRepoOwner,
      repo: RELEASE_DEPLOYMENT_TRUST.gitRepoName,
      repoId: RELEASE_DEPLOYMENT_TRUST.gitRepoId,
      ref: RELEASE_DEPLOYMENT_TRUST.gitRef,
      commitSha: approvedCommitSha,
    },
    sourceManifestSha256: candidate.source.manifestSha256,
    deploymentSource: {
      manifestSha256: candidate.deploymentSource.manifestSha256,
    },
    candidateManifestSha256,
    approvedAirportCandidateSha256: required(
      environment,
      "AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256",
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
    issuedAt,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
  };
  const provenance =
    mode === "prebuilt"
      ? {
          proofMode:
            "vercel-cli-prebuilt-provider-oidc-alias" as const,
          deploymentMethod: "vercel-cli-prebuilt" as const,
          prebuiltArtifact: {
            manifestSha256: prebuiltArtifact!.manifestSha256,
            files: prebuiltArtifact!.manifest.files,
          },
        }
      : {
          proofMode:
            "vercel-cli-source-provider-oidc-alias" as const,
          deploymentMethod: "vercel-cli-source" as const,
          runtimeAttestation: {
            schemaVersion: 6 as const,
            deploymentMethod: "vercel-cli-prebuilt" as const,
          },
          sourceArchive: {
            format: "tgz" as const,
            fileCount: candidate.deploymentSource.files.length,
            files: candidate.deploymentSource.files,
            providerRootDirectory:
              deployment.meta!.gitRootDirectory!,
            providerParts: sourceArchiveProviderParts(provider.files),
            archiveSha256:
              verifyProviderSourceArchiveContents(
                provider.archiveParts ?? [],
                sourceArchiveProviderParts(provider.files),
                candidate.deploymentSource.files,
              ).archiveSha256,
            ...sourceBuildEventEvidence(provider.events),
          },
        };
  const expectationCore = {
    ...core,
    ...provenance,
  } as ProviderReleaseExpectationCore;
  return {
    ...expectationCore,
    expectationSha256:
      providerReleaseExpectationSha256(expectationCore),
  } as ProviderReleaseExpectation;
}

async function main() {
  const expectation = await createProviderReleaseExpectation();
  const artifact = await writeContentAddressedJson(
    path.join(root, "data", "private", "release-approvals"),
    "vercel-provider-expectation",
    expectation,
  );
  console.log(
    canonicalJson({
      providerExpectationPath: path.relative(root, artifact.path),
      providerExpectationSha256: artifact.sha256,
    }).trim(),
  );
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
