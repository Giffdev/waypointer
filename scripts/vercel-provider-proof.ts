import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import {
  releaseRuntimeClaimsSha256,
  type ReleasePhase,
  type ReleaseRuntimeClaims,
} from "../src/lib/release-attestation.ts";
import {
  canonicalJson,
  sha256Bytes,
} from "./airport-release-provenance.ts";
import { requireRepositoryPath } from "./airport-release-safety.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";
import type { VercelPrebuiltArtifactFile } from "./vercel-prebuilt-artifact.ts";

export const RELEASE_DEPLOYMENT_TRUST = {
  platform: "vercel",
  projectId: "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8",
  orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
  teamSlug: "giffdevs-projects",
  projectName: "flight-map",
  environment: "production",
  productionAlias: "flight-map-one.vercel.app",
  gitProvider: "github",
  gitRepoOwner: "giffdev",
  gitRepoName: "waypointer",
  gitRepoId: "1338617639",
  gitRef: "main",
} as const;

const PROVIDER_QUERY_MAX_MS = 5 * 60 * 1_000;
const EXPECTATION_MAX_AGE_MS = 30 * 60 * 1_000;
const OIDC_ISSUERS = [
  "https://oidc.vercel.com",
  `https://oidc.vercel.com/${RELEASE_DEPLOYMENT_TRUST.teamSlug}`,
] as const;
const OIDC_JWKS = createRemoteJWKSet(
  new URL("https://oidc.vercel.com/.well-known/jwks"),
);

export interface ProviderReleaseExpectation {
  schemaVersion: 5;
  proofMode: "vercel-cli-prebuilt-provider-oidc-alias";
  deploymentMethod: "vercel-cli-prebuilt";
  platform: "vercel";
  projectId: string;
  orgId: string;
  teamSlug: string;
  projectName: string;
  environment: "production";
  productionAlias: string;
  releasePhase: ReleasePhase;
  deploymentId: string;
  deploymentUrl: string;
  priorAliasDeploymentId: string;
  sourceCommit: {
    type: "github";
    owner: string;
    repo: string;
    repoId: string;
    ref: string;
    commitSha: string;
  };
  sourceManifestSha256: string;
  deploymentSource: {
    manifestSha256: string;
  };
  prebuiltArtifact: {
    manifestSha256: string;
    files: readonly VercelPrebuiltArtifactFile[];
  };
  candidateManifestSha256: string;
  approvedAirportCandidateSha256: string;
  targetFingerprint: string;
  migrationManifestSha256: string;
  catalogChecksum?: string;
  databaseEvidenceSha256?: string;
  writesPaused: true;
  issuedAt: string;
  expiresAt: string;
  expectationSha256: string;
}

export interface ProviderDeploymentVerification {
  deploymentOrigin: URL;
  aliasOrigin: URL;
  deploymentId: string;
  commitSha: string;
  providerSourceSha256: string;
  requestStartedAt: string;
  requestCompletedAt: string;
  providerVerificationSha256: string;
}

export interface VercelOidcIdentityEvidence {
  issuer: string;
  audience: string;
  subject: string;
  ownerId: string;
  projectId: string;
  environment: string;
  issuedAt: string;
  expiresAt: string;
  tokenSha256: string;
}

export interface ReleaseEndpointEvidence {
  origin: string;
  deploymentId: string;
  commitSha: string;
  sourceManifestSha256: string;
  deploymentSourceManifestSha256: string;
  candidateManifestSha256: string;
  approvedAirportCandidateSha256: string;
  productionAlias: string;
  aliasDeploymentId: string;
  expectationSha256: string;
  runtimeClaimsSha256: string;
  providerSourceSha256: string;
  oidcIdentitySha256: string;
  oidcTokenSha256: string;
  challengeSha256: string;
  providerVerificationSha256: string;
  providerBeforeSha256: string;
  providerAfterSha256: string;
  providerRequestStartedAt: string;
  providerRequestCompletedAt: string;
  responseSha256: string;
  verifiedAt: string;
}

export interface ReleaseEndpointOptions {
  vercelApiToken: string;
  providerFetch?: typeof fetch;
  applicationFetch?: typeof fetch;
  oidcVerify?: typeof verifyVercelOidcIdentity;
  challenge?: string;
}

interface VercelDeploymentResponse {
  id?: string;
  name?: string;
  url?: string;
  projectId?: string;
  ownerId?: string;
  target?: string | null;
  readyState?: string;
  aliases?: string[];
  alias?: string[];
  team?: {
    id?: string;
    slug?: string;
  };
  gitSource?: {
    type?: string;
    org?: string;
    repo?: string;
    repoId?: string | number;
    ref?: string | null;
    sha?: string;
  };
}

interface VercelAliasResponse {
  alias?: string;
  deploymentId?: string;
  projectId?: string;
  redirect?: string | null;
  redirectStatusCode?: number | null;
}

interface VercelFileTreeEntry {
  name?: string;
  type?: string;
  uid?: string;
  mode?: number;
  children?: VercelFileTreeEntry[];
}

interface VercelOidcPayload extends JWTPayload {
  owner?: string;
  owner_id?: string;
  project?: string;
  project_id?: string;
  environment?: string;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function validDeploymentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

function expectationCore(
  expectation: ProviderReleaseExpectation,
): Omit<ProviderReleaseExpectation, "expectationSha256"> {
  const core = { ...expectation };
  delete (core as Partial<ProviderReleaseExpectation>).expectationSha256;
  return core;
}

export function providerReleaseExpectationSha256(
  expectation: Omit<ProviderReleaseExpectation, "expectationSha256">,
): string {
  return sha256Bytes(canonicalJson(expectation));
}

function validateDeploymentSourceFiles(
  files: readonly VercelPrebuiltArtifactFile[],
): void {
  if (
    files.length === 0 ||
    files.some(
      (file, index) =>
        !file.path ||
        path.posix.isAbsolute(file.path) ||
        file.path.split("/").includes("..") ||
        file.path.includes("\\") ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{40}$/.test(file.sha1 ?? "") ||
        !validSha256(file.sha256) ||
        (index > 0 && files[index - 1]!.path >= file.path),
    )
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

function validateExpectation(
  expectation: ProviderReleaseExpectation,
  requiredPhase: ReleasePhase,
  now = Date.now(),
): void {
  const issuedAt = Date.parse(expectation.issuedAt);
  const expiresAt = Date.parse(expectation.expiresAt);
  const hasDatabaseEvidence =
    validSha256(expectation.catalogChecksum) &&
    validSha256(expectation.databaseEvidenceSha256);
  validateDeploymentSourceFiles(expectation.prebuiltArtifact?.files ?? []);
  if (
    expectation.schemaVersion !== 5 ||
    expectation.proofMode !==
      "vercel-cli-prebuilt-provider-oidc-alias" ||
    expectation.deploymentMethod !== "vercel-cli-prebuilt" ||
    expectation.platform !== RELEASE_DEPLOYMENT_TRUST.platform ||
    expectation.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    expectation.orgId !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    expectation.teamSlug !== RELEASE_DEPLOYMENT_TRUST.teamSlug ||
    expectation.projectName !== RELEASE_DEPLOYMENT_TRUST.projectName ||
    expectation.environment !== RELEASE_DEPLOYMENT_TRUST.environment ||
    expectation.productionAlias !==
      RELEASE_DEPLOYMENT_TRUST.productionAlias ||
    expectation.releasePhase !== requiredPhase ||
    !/^dpl_[A-Za-z0-9]{8,256}$/.test(expectation.deploymentId) ||
    !validDeploymentUrl(expectation.deploymentUrl) ||
    !/^dpl_[A-Za-z0-9]{8,256}$/.test(
      expectation.priorAliasDeploymentId,
    ) ||
    expectation.priorAliasDeploymentId === expectation.deploymentId ||
    expectation.sourceCommit?.type !==
      RELEASE_DEPLOYMENT_TRUST.gitProvider ||
    expectation.sourceCommit.owner !==
      RELEASE_DEPLOYMENT_TRUST.gitRepoOwner ||
    expectation.sourceCommit.repo !==
      RELEASE_DEPLOYMENT_TRUST.gitRepoName ||
    expectation.sourceCommit.repoId !==
      RELEASE_DEPLOYMENT_TRUST.gitRepoId ||
    expectation.sourceCommit.ref !== RELEASE_DEPLOYMENT_TRUST.gitRef ||
    !validCommitSha(expectation.sourceCommit.commitSha) ||
    !validSha256(expectation.sourceManifestSha256) ||
    !validSha256(expectation.deploymentSource.manifestSha256) ||
    !validSha256(expectation.prebuiltArtifact.manifestSha256) ||
    !validSha256(expectation.candidateManifestSha256) ||
    !validSha256(expectation.approvedAirportCandidateSha256) ||
    !validSha256(expectation.targetFingerprint) ||
    !validSha256(expectation.migrationManifestSha256) ||
    expectation.writesPaused !== true ||
    (expectation.releasePhase === "control-plane" &&
      (expectation.catalogChecksum !== undefined ||
        expectation.databaseEvidenceSha256 !== undefined)) ||
    (expectation.releasePhase === "database-released" &&
      !hasDatabaseEvidence) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now ||
    now - issuedAt > EXPECTATION_MAX_AGE_MS ||
    expiresAt <= now ||
    expiresAt - issuedAt > EXPECTATION_MAX_AGE_MS ||
    providerReleaseExpectationSha256(expectationCore(expectation)) !==
      expectation.expectationSha256
  ) {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

export async function loadProviderReleaseExpectation(
  environment: NodeJS.ProcessEnv,
  requiredPhase: ReleasePhase = "database-released",
): Promise<ProviderReleaseExpectation> {
  const expectationPath = requireRepositoryPath(
    environment.AIRPORT_RELEASE_PROVIDER_EXPECTATION_PATH,
    path.join("data", "private", "release-approvals"),
    ".json",
  );
  const expectedSha256 =
    environment.AIRPORT_RELEASE_PROVIDER_EXPECTATION_SHA256?.trim() ?? "";
  try {
    const contents = await readFile(expectationPath);
    if (
      !validSha256(expectedSha256) ||
      sha256Bytes(contents) !== expectedSha256
    ) {
      throw new Error("hash");
    }
    const expectation = JSON.parse(
      contents.toString("utf8"),
    ) as ProviderReleaseExpectation;
    validateExpectation(expectation, requiredPhase);
    return expectation;
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
}

function deploymentOrigin(expectation: ProviderReleaseExpectation): URL {
  if (!validDeploymentUrl(expectation.deploymentUrl)) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  return new URL(expectation.deploymentUrl);
}

function validHealthSessionCookie(value: string): boolean {
  const separator = value.indexOf("=");
  if (
    value.length < 20 ||
    value.length > 4096 ||
    separator < 1 ||
    value.includes(";") ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return false;
  }
  const name = value.slice(0, separator);
  return (
    name === "authjs.session-token" ||
    name === "__Secure-authjs.session-token"
  );
}

function flattenProviderFileTree(
  entries: VercelFileTreeEntry[],
  parent = "",
): Array<{ path: string; uid: string; mode: number }> {
  const files: Array<{ path: string; uid: string; mode: number }> = [];
  for (const entry of entries) {
    const name = entry.name ?? "";
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    const filePath = parent ? `${parent}/${name}` : name;
    if (entry.type === "directory") {
      if (!Array.isArray(entry.children)) {
        throw new AirportCatalogSafetyError("health-check-failed");
      }
      files.push(...flattenProviderFileTree(entry.children, filePath));
    } else if (
      entry.type === "file" &&
      typeof entry.uid === "string" &&
      /^[a-f0-9]{40}$/.test(entry.uid) &&
      Number.isSafeInteger(entry.mode)
    ) {
      files.push({ path: filePath, uid: entry.uid, mode: entry.mode! });
    } else {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
  }
  return files;
}

function verifyProviderSource(
  expectation: ProviderReleaseExpectation,
  entries: VercelFileTreeEntry[],
): string {
  const providerFiles = flattenProviderFileTree(entries).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const expectedFiles = expectation.prebuiltArtifact.files;
  if (
    providerFiles.length !== expectedFiles.length ||
    providerFiles.some(
      (file, index) =>
        file.path !== expectedFiles[index]!.path ||
        file.uid !== expectedFiles[index]!.sha1,
    )
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  return sha256Bytes(
    canonicalJson({
      deploymentId: expectation.deploymentId,
      files: providerFiles,
    }),
  );
}

export async function verifyVercelProductionDeployment(
  expectation: ProviderReleaseExpectation,
  token: string,
  fetchImplementation: typeof fetch,
  aliasMode: "immutable-candidate" | "production-alias" = "production-alias",
): Promise<ProviderDeploymentVerification> {
  validateExpectation(expectation, expectation.releasePhase);
  const deploymentUrl = deploymentOrigin(expectation);
  const aliasOrigin = new URL(`https://${expectation.productionAlias}`);
  if (
    token.length < 20 ||
    token.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(token)
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const requestStartedAt = new Date().toISOString();
  const providerRequest = async <T>(providerUrl: URL): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImplementation(providerUrl, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "cache-control": "no-cache, no-store",
          pragma: "no-cache",
        },
      });
    } catch {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    const age = response.headers.get("age");
    if (
      response.status !== 200 ||
      (age !== null && (!/^\d+$/.test(age) || Number(age) !== 0))
    ) {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new AirportCatalogSafetyError("health-check-failed");
    }
  };
  const aliasUrl = new URL(
    `/v4/aliases/${encodeURIComponent(expectation.productionAlias)}`,
    "https://api.vercel.com",
  );
  aliasUrl.searchParams.set("teamId", RELEASE_DEPLOYMENT_TRUST.orgId);
  aliasUrl.searchParams.set("projectId", RELEASE_DEPLOYMENT_TRUST.projectId);
  const deploymentUrlById = new URL(
    `/v13/deployments/${encodeURIComponent(expectation.deploymentId)}`,
    "https://api.vercel.com",
  );
  deploymentUrlById.searchParams.set("teamId", RELEASE_DEPLOYMENT_TRUST.orgId);
  deploymentUrlById.searchParams.set("withGitRepoInfo", "true");
  const deploymentUrlByHost = new URL(
    `/v13/deployments/${encodeURIComponent(deploymentUrl.hostname)}`,
    "https://api.vercel.com",
  );
  deploymentUrlByHost.searchParams.set(
    "teamId",
    RELEASE_DEPLOYMENT_TRUST.orgId,
  );
  deploymentUrlByHost.searchParams.set("withGitRepoInfo", "true");
  const filesUrl = new URL(
    `/v6/deployments/${encodeURIComponent(expectation.deploymentId)}/files`,
    "https://api.vercel.com",
  );
  filesUrl.searchParams.set("teamId", RELEASE_DEPLOYMENT_TRUST.orgId);

  const aliasBefore =
    await providerRequest<VercelAliasResponse>(aliasUrl);
  const deployment =
    await providerRequest<VercelDeploymentResponse>(deploymentUrlById);
  const deploymentByHost =
    await providerRequest<VercelDeploymentResponse>(deploymentUrlByHost);
  const providerFiles =
    await providerRequest<VercelFileTreeEntry[]>(filesUrl);
  const aliasAfter =
    await providerRequest<VercelAliasResponse>(aliasUrl);
  const aliases = deployment.aliases ?? deployment.alias ?? [];
  const expectedAliasDeploymentId =
    aliasMode === "production-alias"
      ? expectation.deploymentId
      : expectation.priorAliasDeploymentId;
  const sameDeployment =
    deploymentByHost.id === deployment.id &&
    deploymentByHost.projectId === deployment.projectId &&
    deploymentByHost.ownerId === deployment.ownerId &&
    deploymentByHost.url === deployment.url &&
    deploymentByHost.target === deployment.target &&
    deploymentByHost.readyState === deployment.readyState &&
    deploymentByHost.gitSource == null;
  if (
    aliasBefore.alias !== expectation.productionAlias ||
    aliasAfter.alias !== expectation.productionAlias ||
    aliasBefore.deploymentId !== expectedAliasDeploymentId ||
    aliasAfter.deploymentId !== expectedAliasDeploymentId ||
    aliasBefore.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    aliasAfter.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    aliasBefore.redirect != null ||
    aliasAfter.redirect != null ||
    aliasBefore.redirectStatusCode != null ||
    aliasAfter.redirectStatusCode != null ||
    deployment.id !== expectation.deploymentId ||
    deployment.name !== RELEASE_DEPLOYMENT_TRUST.projectName ||
    deployment.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    deployment.ownerId !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    deployment.team?.id !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    deployment.team.slug !== RELEASE_DEPLOYMENT_TRUST.teamSlug ||
    deployment.target !== RELEASE_DEPLOYMENT_TRUST.environment ||
    deployment.readyState !== "READY" ||
    deployment.url !== deploymentUrl.hostname ||
    (aliasMode === "production-alias") !==
      aliases.includes(expectation.productionAlias) ||
    !sameDeployment ||
    deployment.gitSource != null
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const providerSourceSha256 = verifyProviderSource(
    expectation,
    providerFiles,
  );
  const requestCompletedAt = new Date().toISOString();
  if (
    Date.parse(requestCompletedAt) - Date.parse(requestStartedAt) >
    PROVIDER_QUERY_MAX_MS
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const providerRecord = {
    alias: expectation.productionAlias,
    aliasDeploymentId: aliasAfter.deploymentId,
    deploymentId: deployment.id,
    deploymentUrl: deploymentUrl.origin,
    environment: deployment.target,
    aliasMode,
    sourceCommit: expectation.sourceCommit,
    orgId: deployment.ownerId,
    projectId: deployment.projectId,
    projectName: deployment.name,
    providerSourceSha256,
    readyState: deployment.readyState,
    requestCompletedAt,
    requestStartedAt,
    teamSlug: deployment.team.slug,
  };
  return {
    deploymentOrigin: deploymentUrl,
    aliasOrigin,
    deploymentId: expectation.deploymentId,
    commitSha: expectation.sourceCommit.commitSha,
    providerSourceSha256,
    requestStartedAt,
    requestCompletedAt,
    providerVerificationSha256: sha256Bytes(canonicalJson(providerRecord)),
  };
}

export async function verifyVercelOidcIdentity(
  token: string,
  challenge: string,
  keySet: Parameters<typeof jwtVerify>[1] = OIDC_JWKS,
  now = Date.now(),
): Promise<VercelOidcIdentityEvidence> {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    token.length < 100 ||
    token.length > 16_384
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const audience = `urn:flight-map:release-health:${challenge}`;
  const subject =
    `owner:${RELEASE_DEPLOYMENT_TRUST.teamSlug}:` +
    `project:${RELEASE_DEPLOYMENT_TRUST.projectName}:` +
    "environment:production";
  let payload: VercelOidcPayload;
  try {
    ({ payload } = await jwtVerify<VercelOidcPayload>(token, keySet, {
      algorithms: ["RS256"],
      audience,
      issuer: [...OIDC_ISSUERS],
      subject,
    }));
  } catch {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  if (
    payload.owner !== RELEASE_DEPLOYMENT_TRUST.teamSlug ||
    payload.owner_id !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    payload.project !== RELEASE_DEPLOYMENT_TRUST.projectName ||
    payload.project_id !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    payload.environment !== RELEASE_DEPLOYMENT_TRUST.environment ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt * 1_000 > now + 30_000 ||
    expiresAt * 1_000 <= now ||
    expiresAt - issuedAt > 2 * 60 * 60 + 60
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  return {
    issuer: String(payload.iss),
    audience,
    subject,
    ownerId: payload.owner_id,
    projectId: payload.project_id,
    environment: payload.environment,
    issuedAt: new Date(issuedAt * 1_000).toISOString(),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
    tokenSha256: createHash("sha256").update(token).digest("hex"),
  };
}

function runtimeClaimsMatch(
  claims: ReleaseRuntimeClaims,
  expectation: ProviderReleaseExpectation,
): boolean {
  return Boolean(
    claims.schemaVersion === 5 &&
      claims.deploymentMethod === expectation.deploymentMethod &&
      releaseRuntimeClaimsSha256(
        Object.fromEntries(
          Object.entries(claims).filter(
            ([key]) => key !== "runtimeClaimsSha256",
          ),
        ) as Omit<ReleaseRuntimeClaims, "runtimeClaimsSha256">,
      ) === claims.runtimeClaimsSha256 &&
      claims.releasePhase === expectation.releasePhase &&
      claims.deploymentId === expectation.deploymentId &&
      claims.deploymentUrl === expectation.deploymentUrl &&
      claims.projectId === expectation.projectId &&
      claims.productionUrl === expectation.productionAlias &&
      claims.environment === expectation.environment &&
      claims.targetEnvironment === expectation.environment &&
      claims.gitProvider === expectation.sourceCommit.type &&
      claims.gitRepoOwner === expectation.sourceCommit.owner &&
      claims.gitRepoName === expectation.sourceCommit.repo &&
      claims.gitRepoId === expectation.sourceCommit.repoId &&
      claims.gitCommitRef === expectation.sourceCommit.ref &&
      claims.gitCommitSha === expectation.sourceCommit.commitSha &&
      claims.sourceManifestSha256 === expectation.sourceManifestSha256 &&
      claims.deploymentSourceManifestSha256 ===
        expectation.deploymentSource.manifestSha256 &&
      claims.candidateManifestSha256 ===
        expectation.candidateManifestSha256 &&
      claims.approvedAirportCandidateSha256 ===
        expectation.approvedAirportCandidateSha256 &&
      claims.targetFingerprint === expectation.targetFingerprint &&
      claims.migrationManifestSha256 ===
        expectation.migrationManifestSha256 &&
      claims.catalogChecksum === expectation.catalogChecksum &&
      claims.databaseEvidenceSha256 ===
        expectation.databaseEvidenceSha256 &&
      claims.writesPaused === true
  );
}

async function verifyReleaseEndpointAtOrigin(
  expectation: ProviderReleaseExpectation,
  sessionCookie: string,
  options: ReleaseEndpointOptions,
  aliasMode: "immutable-candidate" | "production-alias",
): Promise<ReleaseEndpointEvidence> {
  validateExpectation(expectation, expectation.releasePhase);
  if (!validHealthSessionCookie(sessionCookie)) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const verified = await verifyVercelProductionDeployment(
    expectation,
    options.vercelApiToken,
    options.providerFetch ?? fetch,
    aliasMode,
  );
  const challenge =
    options.challenge ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const fetchImplementation = options.applicationFetch ?? fetch;
  const releaseOrigin =
    aliasMode === "production-alias"
      ? verified.aliasOrigin
      : verified.deploymentOrigin;
  const releaseUrl = new URL("/api/health/release", releaseOrigin);
  releaseUrl.searchParams.set("challenge", challenge);
  const releaseResponse = await fetchImplementation(releaseUrl, {
    redirect: "manual",
    cache: "no-store",
    headers: {
      cookie: sessionCookie,
      origin: releaseOrigin.origin,
      "cache-control": "no-cache, no-store",
      pragma: "no-cache",
    },
  });
  if (
    releaseResponse.status !== 200 ||
    !releaseResponse.headers.get("cache-control")?.includes("no-store")
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const releasePayload = (await releaseResponse.json()) as {
    status?: string;
    runtimeWriteMode?: string;
    challenge?: string;
    runtime?: ReleaseRuntimeClaims;
    providerIdentity?: { oidcToken?: string };
  };
  const oidcToken = releasePayload.providerIdentity?.oidcToken ?? "";
  const oidcIdentity = await (
    options.oidcVerify ?? verifyVercelOidcIdentity
  )(oidcToken, challenge);
  if (
    releasePayload.status !== "ok" ||
    releasePayload.runtimeWriteMode !== "read-only" ||
    releasePayload.challenge !== challenge ||
    !releasePayload.runtime ||
    !runtimeClaimsMatch(releasePayload.runtime, expectation)
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const verifiedAfter = await verifyVercelProductionDeployment(
    expectation,
    options.vercelApiToken,
    options.providerFetch ?? fetch,
    aliasMode,
  );
  if (
    verifiedAfter.deploymentId !== verified.deploymentId ||
    verifiedAfter.commitSha !== verified.commitSha ||
    verifiedAfter.providerSourceSha256 !== verified.providerSourceSha256
  ) {
    throw new AirportCatalogSafetyError("health-check-failed");
  }
  const responseRecord = {
    challenge,
    oidcIdentity,
    runtime: releasePayload.runtime,
    status: releasePayload.status,
  };
  return {
    origin: releaseOrigin.origin,
    deploymentId: expectation.deploymentId,
    commitSha: expectation.sourceCommit.commitSha,
    sourceManifestSha256: expectation.sourceManifestSha256,
    deploymentSourceManifestSha256:
      expectation.deploymentSource.manifestSha256,
    candidateManifestSha256: expectation.candidateManifestSha256,
    approvedAirportCandidateSha256:
      expectation.approvedAirportCandidateSha256,
    productionAlias: expectation.productionAlias,
    aliasDeploymentId:
      aliasMode === "production-alias"
        ? verifiedAfter.deploymentId
        : expectation.priorAliasDeploymentId,
    expectationSha256: expectation.expectationSha256,
    runtimeClaimsSha256: releasePayload.runtime.runtimeClaimsSha256,
    providerSourceSha256: verified.providerSourceSha256,
    oidcIdentitySha256: sha256Bytes(canonicalJson(oidcIdentity)),
    oidcTokenSha256: oidcIdentity.tokenSha256,
    challengeSha256: sha256Bytes(challenge),
    providerVerificationSha256: sha256Bytes(
      canonicalJson({
        after: verifiedAfter.providerVerificationSha256,
        before: verified.providerVerificationSha256,
      }),
    ),
    providerBeforeSha256: verified.providerVerificationSha256,
    providerAfterSha256: verifiedAfter.providerVerificationSha256,
    providerRequestStartedAt: verified.requestStartedAt,
    providerRequestCompletedAt: verifiedAfter.requestCompletedAt,
    responseSha256: sha256Bytes(canonicalJson(responseRecord)),
    verifiedAt: new Date().toISOString(),
  };
}

export async function verifyImmutableReleaseCandidate(
  expectation: ProviderReleaseExpectation,
  sessionCookie: string,
  options: ReleaseEndpointOptions,
): Promise<ReleaseEndpointEvidence> {
  return verifyReleaseEndpointAtOrigin(
    expectation,
    sessionCookie,
    options,
    "immutable-candidate",
  );
}

export async function verifyReleaseEndpoint(
  expectation: ProviderReleaseExpectation,
  sessionCookie: string,
  options: ReleaseEndpointOptions,
): Promise<ReleaseEndpointEvidence> {
  return verifyReleaseEndpointAtOrigin(
    expectation,
    sessionCookie,
    options,
    "production-alias",
  );
}
