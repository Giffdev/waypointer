import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  providerJson,
  runVercel,
  sanitizedDeploymentEnvironment,
} from "./deploy-production.ts";
import {
  loadProviderReleaseExpectation,
  RELEASE_DEPLOYMENT_TRUST,
  verifyImmutableReleaseCandidate,
  verifyReleaseEndpoint,
} from "./vercel-provider-proof.ts";

const root = path.resolve(import.meta.dirname, "..");

interface VercelDeployment {
  readonly id?: string;
  readonly url?: string;
  readonly projectId?: string;
  readonly ownerId?: string;
  readonly readyState?: string;
}

interface VercelAlias {
  readonly alias?: string;
  readonly deploymentId?: string;
  readonly projectId?: string;
  readonly redirect?: string | null;
  readonly redirectStatusCode?: number | null;
}

export interface PromotionDependencies {
  readonly loadExpectation?: typeof loadProviderReleaseExpectation;
  readonly verifyImmutable?: typeof verifyImmutableReleaseCandidate;
  readonly verifyAlias?: typeof verifyReleaseEndpoint;
  readonly providerRequest?: <T>(
    providerPath: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<T>;
  readonly runCli?: typeof runVercel;
  readonly verifyPublicAuth?: typeof verifyPublicAuthRoutes;
  readonly writeEvidence?: typeof writeContentAddressedJson;
  readonly challenge?: () => string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function verifyPublicAuthRoutes(origin: string): Promise<void> {
  for (const pathname of ["/auth/register", "/auth/sign-in"]) {
    const response = await fetch(new URL(pathname, origin), {
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

async function aliasOwner(
  environment: NodeJS.ProcessEnv,
  providerRequest: NonNullable<
    PromotionDependencies["providerRequest"]
  >,
): Promise<VercelAlias> {
  return providerRequest<VercelAlias>(
    `/v4/aliases/${RELEASE_DEPLOYMENT_TRUST.productionAlias}` +
      `?teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}` +
      `&projectId=${RELEASE_DEPLOYMENT_TRUST.projectId}`,
    environment,
  );
}

export async function promoteProductionCandidate(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: PromotionDependencies = {},
): Promise<Record<string, unknown>> {
  const loadExpectation =
    dependencies.loadExpectation ?? loadProviderReleaseExpectation;
  const verifyImmutable =
    dependencies.verifyImmutable ?? verifyImmutableReleaseCandidate;
  const verifyAlias = dependencies.verifyAlias ?? verifyReleaseEndpoint;
  const providerRequest = dependencies.providerRequest ?? providerJson;
  const runCli = dependencies.runCli ?? runVercel;
  const verifyPublicAuth =
    dependencies.verifyPublicAuth ?? verifyPublicAuthRoutes;
  const writeEvidence =
    dependencies.writeEvidence ?? writeContentAddressedJson;
  const expectation = await loadExpectation(
    environment,
    "control-plane",
  );
  const vercelApiToken = required(environment, "VERCEL_TOKEN");
  const sessionCookie = required(
    environment,
    "AIRPORT_RELEASE_HEALTH_SESSION_COOKIE",
  );
  const childEnvironment = sanitizedDeploymentEnvironment(environment);
  const challenge =
    dependencies.challenge?.() ??
    randomBytes(32).toString("base64url");
  const immutableEvidence = await verifyImmutable(
    expectation,
    sessionCookie,
    { vercelApiToken, challenge },
  );
  const priorDeployment = await providerRequest<VercelDeployment>(
    `/v13/deployments/${expectation.priorAliasDeploymentId}` +
      `?teamId=${RELEASE_DEPLOYMENT_TRUST.orgId}`,
    childEnvironment,
  );
  if (
    priorDeployment.id !== expectation.priorAliasDeploymentId ||
    priorDeployment.projectId !== RELEASE_DEPLOYMENT_TRUST.projectId ||
    priorDeployment.ownerId !== RELEASE_DEPLOYMENT_TRUST.orgId ||
    priorDeployment.readyState !== "READY" ||
    !/^[A-Za-z0-9.-]+\.vercel\.app$/u.test(priorDeployment.url ?? "")
  ) {
    throw new Error("Prior production deployment cannot be restored safely");
  }

  try {
    await runCli(
      [
        "alias",
        "set",
        expectation.deploymentUrl,
        RELEASE_DEPLOYMENT_TRUST.productionAlias,
        "--scope",
        RELEASE_DEPLOYMENT_TRUST.teamSlug,
      ],
      { environment: childEnvironment },
    );
    const aliasEvidence = await verifyAlias(
      expectation,
      sessionCookie,
      { vercelApiToken, challenge },
    );
    await verifyPublicAuth(aliasEvidence.origin);
    const artifact = await writeEvidence(
      path.join(root, "artifacts", "release-evidence", "vercel-deployment"),
      "production-promotion",
      {
        status: "DEPLOYED",
        projectId: expectation.projectId,
        orgId: expectation.orgId,
        deploymentId: expectation.deploymentId,
        immutableUrl: expectation.deploymentUrl,
        productionAlias: expectation.productionAlias,
        priorAliasDeploymentId: expectation.priorAliasDeploymentId,
        aliasDeploymentId: aliasEvidence.aliasDeploymentId,
        commitSha: expectation.sourceCommit.commitSha,
        candidateManifestSha256:
          expectation.candidateManifestSha256,
        immutableHealthOutcome: "ok",
        aliasHealthOutcome: "ok",
        publicRegistrationReachable: true,
        publicSignInReachable: true,
        writesPaused: true,
        promotedAt: new Date().toISOString(),
      },
    );
    return {
      status: "DEPLOYED",
      deploymentId: expectation.deploymentId,
      liveUrl: `https://${expectation.productionAlias}`,
      immutableUrl: expectation.deploymentUrl,
      healthOutcome: "ok",
      evidencePath: path.relative(root, artifact.path),
      evidenceSha256: artifact.sha256,
    };
  } catch (error) {
    let restored: VercelAlias = {};
    let restoreFailureClass: string | undefined;
    try {
      await runCli(
        [
          "alias",
          "set",
          `https://${priorDeployment.url}`,
          RELEASE_DEPLOYMENT_TRUST.productionAlias,
          "--scope",
          RELEASE_DEPLOYMENT_TRUST.teamSlug,
        ],
        { environment: childEnvironment },
      );
      restored = await aliasOwner(childEnvironment, providerRequest);
    } catch (restoreError) {
      restoreFailureClass =
        restoreError instanceof Error
          ? restoreError.name
          : "UnknownError";
    }
    const restoredSafely =
      restored.alias === RELEASE_DEPLOYMENT_TRUST.productionAlias &&
      restored.projectId === RELEASE_DEPLOYMENT_TRUST.projectId &&
      restored.deploymentId === expectation.priorAliasDeploymentId &&
      restored.redirect === null &&
      restored.redirectStatusCode === null;
    const artifact = await writeEvidence(
      path.join(root, "artifacts", "release-evidence", "vercel-deployment"),
      "production-rollback",
      {
        status: restoredSafely ? "ROLLED_BACK" : "BLOCKED",
        projectId: expectation.projectId,
        orgId: expectation.orgId,
        deploymentId: expectation.deploymentId,
        immutableUrl: expectation.deploymentUrl,
        productionAlias: expectation.productionAlias,
        priorAliasDeploymentId: expectation.priorAliasDeploymentId,
        immutableProviderVerificationSha256:
          immutableEvidence.providerVerificationSha256,
        restoredAliasOwner: restored.deploymentId ?? null,
        restoredAliasRedirect: restored.redirect ?? null,
        restoredAliasRedirectStatusCode:
          restored.redirectStatusCode ?? null,
        restoredSafely,
        failureClass:
          error instanceof Error ? error.name : "UnknownError",
        restoreFailureClass,
        recordedAt: new Date().toISOString(),
      },
    );
    throw new Error(
      `${restoredSafely ? "Promotion failed and prior alias was restored" : "Promotion failed and alias restoration was not verified"}; evidence ${path.relative(root, artifact.path)}`,
    );
  }
}

async function main() {
  console.log(canonicalJson(await promoteProductionCandidate()).trim());
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
