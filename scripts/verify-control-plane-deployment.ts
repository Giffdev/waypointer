import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  loadProviderReleaseExpectation,
  verifyImmutableReleaseCandidate,
  verifyReleaseEndpoint,
} from "./vercel-provider-proof.ts";

const root = path.resolve(import.meta.dirname, "..");

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function verifyControlPlaneDeployment(
  environment: NodeJS.ProcessEnv = process.env,
  mode: "immutable-candidate" | "production-alias" =
    "immutable-candidate",
): Promise<Record<string, unknown>> {
  const expectation = await loadProviderReleaseExpectation(
    environment,
    "control-plane",
  );
  const options = {
    vercelApiToken: required(environment, "VERCEL_TOKEN"),
  };
  const sessionCookie = required(
    environment,
    "AIRPORT_RELEASE_HEALTH_SESSION_COOKIE",
  );
  const evidence =
    mode === "immutable-candidate"
      ? await verifyImmutableReleaseCandidate(
          expectation,
          sessionCookie,
          options,
        )
      : await verifyReleaseEndpoint(expectation, sessionCookie, options);
  const artifact = await writeContentAddressedJson(
    path.join(root, "artifacts", "release-evidence", "vercel-deployment"),
    mode,
    {
      mode,
      projectId: expectation.projectId,
      orgId: expectation.orgId,
      deploymentId: evidence.deploymentId,
      immutableUrl: expectation.deploymentUrl,
      productionAlias: expectation.productionAlias,
      aliasDeploymentId: evidence.aliasDeploymentId,
      commitSha: evidence.commitSha,
      candidateManifestSha256: evidence.candidateManifestSha256,
      providerSourceSha256: evidence.providerSourceSha256,
      runtimeClaimsSha256: evidence.runtimeClaimsSha256,
      oidcIdentitySha256: evidence.oidcIdentitySha256,
      healthOrigin: evidence.origin,
      healthOutcome: "ok",
      verifiedAt: evidence.verifiedAt,
    },
  );
  return {
    status: "VERIFIED",
    mode,
    deploymentId: evidence.deploymentId,
    origin: evidence.origin,
    evidencePath: path.relative(root, artifact.path),
    evidenceSha256: artifact.sha256,
  };
}

async function main() {
  const mode = process.argv.includes("--production-alias")
    ? "production-alias"
    : "immutable-candidate";
  console.log(
    canonicalJson(await verifyControlPlaneDeployment(process.env, mode)).trim(),
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
