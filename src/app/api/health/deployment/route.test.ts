import { getVercelOidcToken } from "@vercel/oidc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseRuntimeClaimsFromEnvironment } from "@/lib/release-attestation";
import { GET } from "./route";

const challenge = "c".repeat(43);
const runtime = {
  schemaVersion: 6,
  deploymentMethod: "vercel-cli-prebuilt",
  releasePhase: "control-plane",
  deploymentId: "dpl_12345678",
  deploymentUrl: "https://candidate.vercel.app",
  projectId: "prj_12345678",
  productionUrl: "flight-map-one.vercel.app",
  environment: "production",
  targetEnvironment: "production",
  gitProvider: "github",
  gitRepoOwner: "giffdev",
  gitRepoName: "waypointer",
  gitRepoId: "1338617639",
  gitCommitRef: "main",
  gitCommitSha: "0".repeat(40),
  sourceManifestSha256: "1".repeat(64),
  deploymentSourceManifestSha256: "2".repeat(64),
  candidateManifestSha256: "3".repeat(64),
  approvedAirportCandidateSha256: "4".repeat(64),
  migrationManifestSha256: "6".repeat(64),
  writesPaused: true,
  runtimeClaimsSha256: "7".repeat(64),
} as const;

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(),
}));
vi.mock("@/lib/release-attestation", () => ({
  releaseRuntimeClaimsFromEnvironment: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getVercelOidcToken).mockReset();
  vi.mocked(getVercelOidcToken).mockResolvedValue("provider-signed-token");
  vi.mocked(releaseRuntimeClaimsFromEnvironment).mockReset();
  vi.mocked(releaseRuntimeClaimsFromEnvironment).mockReturnValue(
    runtime as never,
  );
});

describe("deployment attestation endpoint", () => {
  it("returns only challenge-bound provider identity and runtime claims", async () => {
    const response = await GET(
      new Request(
        `https://candidate.vercel.app/api/health/deployment?challenge=${challenge}`,
        { headers: { origin: "https://candidate.vercel.app" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      challenge,
      runtime,
      providerIdentity: { oidcToken: "provider-signed-token" },
    });
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      audience: `urn:flight-map:deployment-attestation:${challenge}`,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects invalid challenges and cross-origin browser requests", async () => {
    expect(
      (
        await GET(
          new Request("https://candidate.vercel.app/api/health/deployment", {
            headers: { origin: "https://candidate.vercel.app" },
          }),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await GET(
          new Request(
            `https://candidate.vercel.app/api/health/deployment?challenge=${challenge}`,
            { headers: { origin: "https://preview.vercel.app" } },
          ),
        )
      ).status,
    ).toBe(403);
  });
});
