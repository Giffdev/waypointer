import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  verifyCandidateManifest,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  providerReleaseExpectationSha256,
  RELEASE_DEPLOYMENT_TRUST,
  type ProviderReleaseExpectation,
} from "./vercel-provider-proof.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");

export interface CleanGitSource {
  commitSha: string;
  ref: string;
}

export type GitRunner = (args: string[]) => Promise<string>;

async function defaultGitRunner(args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
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
    const ref = await runGit(["branch", "--show-current"]);
    const remote = await runGit(["remote", "get-url", "origin"]);
    const normalizedRemote = remote
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
    if (
      status !== "" ||
      !/^[a-f0-9]{40}$/.test(commitSha) ||
      !/^[A-Za-z0-9._/-]{1,256}$/.test(ref) ||
      normalizedRemote.toLowerCase() !==
        `https://github.com/${RELEASE_DEPLOYMENT_TRUST.gitRepoOwner}/${RELEASE_DEPLOYMENT_TRUST.gitRepoName}`.toLowerCase()
    ) {
      throw new Error("git");
    }
    return { commitSha, ref };
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
): Promise<ProviderReleaseExpectation> {
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
  const candidate = await verifyCandidateManifest(
    path.resolve(root, candidateManifestPath),
    candidateManifestSha256,
  );
  const git = await resolveCleanGitSource(runGit);
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
    schemaVersion: 4 as const,
    proofMode: "vercel-api-source-and-oidc" as const,
    platform: RELEASE_DEPLOYMENT_TRUST.platform,
    projectId: RELEASE_DEPLOYMENT_TRUST.projectId,
    orgId: RELEASE_DEPLOYMENT_TRUST.orgId,
    teamSlug: RELEASE_DEPLOYMENT_TRUST.teamSlug,
    projectName: RELEASE_DEPLOYMENT_TRUST.projectName,
    environment: RELEASE_DEPLOYMENT_TRUST.environment,
    productionAlias: RELEASE_DEPLOYMENT_TRUST.productionAlias,
    releasePhase,
    deploymentId: required(
      environment,
      "AIRPORT_RELEASE_DEPLOYMENT_ID",
      /^dpl_[A-Za-z0-9]{8,256}$/,
    ),
    deploymentUrl: required(
      environment,
      "AIRPORT_RELEASE_DEPLOYMENT_URL",
      /^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/,
    ).toLowerCase(),
    gitSource: {
      type: RELEASE_DEPLOYMENT_TRUST.gitProvider,
      owner: RELEASE_DEPLOYMENT_TRUST.gitRepoOwner,
      repo: RELEASE_DEPLOYMENT_TRUST.gitRepoName,
      repoId: required(
        environment,
        "AIRPORT_RELEASE_GIT_REPO_ID",
        /^[A-Za-z0-9_.:-]{1,128}$/,
      ),
      ref: git.ref,
      commitSha: git.commitSha,
    },
    sourceManifestSha256: candidate.source.manifestSha256,
    deploymentSource: {
      manifestSha256: candidate.deploymentSource.manifestSha256,
      files: candidate.deploymentSource.files,
    },
    candidateManifestSha256,
    approvedAirportCandidateSha256: required(
      environment,
      "AIRPORT_RELEASE_APPROVED_AIRPORT_CANDIDATE_SHA256",
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
    issuedAt,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
  };
  return {
    ...core,
    expectationSha256: providerReleaseExpectationSha256(core),
  };
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
