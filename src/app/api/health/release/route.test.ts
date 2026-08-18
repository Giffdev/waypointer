import { getVercelOidcToken } from "@vercel/oidc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationRequiredError,
  requireAuthenticatedUser,
} from "@/lib/auth/guards";
import { verifyRuntimeWritePause } from "@/lib/db";
import { releaseRuntimeClaimsFromEnvironment } from "@/lib/release-attestation";
import { GET } from "./route";

const challenge = "c".repeat(43);
const runtime = {
  schemaVersion: 5,
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
  targetFingerprint: "5".repeat(64),
  migrationManifestSha256: "6".repeat(64),
  writesPaused: true,
  runtimeClaimsSha256: "7".repeat(64),
} as const;

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(),
}));
vi.mock("@/lib/auth/guards", async () => {
  class MockAuthenticationRequiredError extends Error {}
  return {
    AuthenticationRequiredError: MockAuthenticationRequiredError,
    requireAuthenticatedUser: vi.fn(),
  };
});
vi.mock("@/lib/db", () => ({ verifyRuntimeWritePause: vi.fn() }));
vi.mock("@/lib/release-attestation", () => ({
  releaseRuntimeClaimsFromEnvironment: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(requireAuthenticatedUser).mockReset();
  vi.mocked(verifyRuntimeWritePause).mockReset();
  vi.mocked(getVercelOidcToken).mockReset();
  vi.mocked(getVercelOidcToken).mockResolvedValue("provider-signed-token");
  vi.mocked(releaseRuntimeClaimsFromEnvironment).mockReset();
  vi.mocked(releaseRuntimeClaimsFromEnvironment).mockReturnValue(
    runtime as never,
  );
});

describe("release health endpoint", () => {
  it("returns challenge-bound provider identity and runtime claims", async () => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "health@example.test",
    });
    vi.mocked(verifyRuntimeWritePause).mockResolvedValue();
    const response = await GET(
      new Request(
        `https://candidate.vercel.app/api/health/release?challenge=${challenge}`,
        { headers: { origin: "https://candidate.vercel.app" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      runtimeWriteMode: "read-only",
      challenge,
      runtime,
      providerIdentity: { oidcToken: "provider-signed-token" },
    });
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      audience: `urn:flight-map:release-health:${challenge}`,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when provider identity or challenge is unavailable", async () => {
    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "health@example.test",
    });
    vi.mocked(verifyRuntimeWritePause).mockResolvedValue();
    vi.mocked(getVercelOidcToken).mockRejectedValueOnce(
      new Error("OIDC unavailable"),
    );
    expect(
      (
        await GET(
          new Request(
            `https://candidate.vercel.app/api/health/release?challenge=${challenge}`,
            { headers: { origin: "https://candidate.vercel.app" } },
          ),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await GET(
          new Request("https://candidate.vercel.app/api/health/release", {
            headers: { origin: "https://candidate.vercel.app" },
          }),
        )
      ).status,
    ).toBe(503);
  });

  it("rejects unauthenticated, cross-origin, and unverified write-pause requests", async () => {
    vi.mocked(requireAuthenticatedUser).mockRejectedValueOnce(
      new AuthenticationRequiredError(),
    );
    expect(
      (
        await GET(
          new Request(
            `https://candidate.vercel.app/api/health/release?challenge=${challenge}`,
            { headers: { origin: "https://candidate.vercel.app" } },
          ),
        )
      ).status,
    ).toBe(401);

    vi.mocked(requireAuthenticatedUser).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "health@example.test",
    });
    expect(
      (
        await GET(
          new Request(
            `https://candidate.vercel.app/api/health/release?challenge=${challenge}`,
            { headers: { origin: "https://preview.vercel.app" } },
          ),
        )
      ).status,
    ).toBe(403);

    vi.mocked(verifyRuntimeWritePause).mockRejectedValueOnce(
      new Error("not read-only"),
    );
    expect(
      (
        await GET(
          new Request(
            `https://candidate.vercel.app/api/health/release?challenge=${challenge}`,
            { headers: { origin: "https://candidate.vercel.app" } },
          ),
        )
      ).status,
    ).toBe(503);
  });
});
