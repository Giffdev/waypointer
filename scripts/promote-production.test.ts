import { describe, expect, it, vi } from "vitest";

import type { ProviderReleaseExpectation } from "./vercel-provider-proof";
import { promoteProductionCandidate } from "./promote-production";

const expectation = {
  projectId: "prj_1XEu7EWNl1Eekl3TKQ6FnKnGznv8",
  orgId: "team_qymLK9gugmE5lSs2mxC5XqRY",
  deploymentId: "dpl_candidate123",
  deploymentUrl: "https://flight-map-candidate.vercel.app",
  productionAlias: "flight-map-one.vercel.app",
  priorAliasDeploymentId: "dpl_previous123",
  sourceCommit: { commitSha: "a".repeat(40) },
  candidateManifestSha256: "b".repeat(64),
} as ProviderReleaseExpectation;

const environment = {
  NODE_ENV: "test" as const,
};

function immutableEvidence() {
  return {
    providerVerificationSha256: "c".repeat(64),
  } as never;
}

function aliasEvidence() {
  return {
    origin: "https://flight-map-one.vercel.app",
    aliasDeploymentId: expectation.deploymentId,
  } as never;
}

describe("promote-production", () => {
  it("verifies immutable attestation before aliasing and re-verifies afterward", async () => {
    const events: string[] = [];
    const runCli = vi.fn(async (args: readonly string[]) => {
      events.push(
        args[2] === expectation.deploymentUrl
          ? "promote-alias"
          : "restore-alias",
      );
      return { stdout: "" };
    });

    await expect(
      promoteProductionCandidate(environment, {
        loadExpectation: async () => expectation,
        verifyImmutable: async () => {
          events.push("verify-immutable");
          return immutableEvidence();
        },
        providerRequest: async () => {
          events.push("load-prior");
          return {
            id: expectation.priorAliasDeploymentId,
            url: "flight-map-previous.vercel.app",
            projectId: expectation.projectId,
            ownerId: expectation.orgId,
            readyState: "READY",
          } as never;
        },
        runCli: runCli as never,
        verifyAlias: async () => {
          events.push("verify-alias");
          return aliasEvidence();
        },
        verifyPublicAuth: async () => {
          events.push("verify-public-auth");
        },
        writeEvidence: async () => {
          events.push("write-evidence");
          return {
            path: "artifacts/release-evidence/promotion.json",
            sha256: "d".repeat(64),
          };
        },
        challenge: () => "e".repeat(43),
      }),
    ).resolves.toMatchObject({
      status: "DEPLOYED",
      deploymentId: expectation.deploymentId,
    });

    expect(events).toEqual([
      "verify-immutable",
      "load-prior",
      "promote-alias",
      "verify-alias",
      "verify-public-auth",
      "write-evidence",
    ]);
  });

  it("restores and verifies the prior alias after post-promotion failure", async () => {
    const aliases: string[] = [];
    const writeEvidence = vi.fn(async (_directory, _prefix, value) => ({
      path: "artifacts/release-evidence/rollback.json",
      sha256:
        (value as { restoredSafely?: boolean }).restoredSafely === true
          ? "d".repeat(64)
          : "f".repeat(64),
    }));
    let providerRequestCount = 0;

    await expect(
      promoteProductionCandidate(environment, {
        loadExpectation: async () => expectation,
        verifyImmutable: async () => immutableEvidence(),
        providerRequest: async () => {
          providerRequestCount += 1;
          if (providerRequestCount === 1) {
            return {
              id: expectation.priorAliasDeploymentId,
              url: "flight-map-previous.vercel.app",
              projectId: expectation.projectId,
              ownerId: expectation.orgId,
              readyState: "READY",
            } as never;
          }
          return {
            alias: expectation.productionAlias,
            deploymentId: expectation.priorAliasDeploymentId,
            projectId: expectation.projectId,
            redirect: null,
            redirectStatusCode: null,
          } as never;
        },
        runCli: (async (args: readonly string[]) => {
          aliases.push(args[2]!);
          return { stdout: "" };
        }) as never,
        verifyAlias: async () => {
          throw new Error("post-promotion health failed");
        },
        writeEvidence: writeEvidence as never,
        challenge: () => "e".repeat(43),
      }),
    ).rejects.toThrow(/prior alias was restored/);

    expect(aliases).toEqual([
      expectation.deploymentUrl,
      "https://flight-map-previous.vercel.app",
    ]);
    expect(writeEvidence).toHaveBeenCalledWith(
      expect.any(String),
      "production-rollback",
      expect.objectContaining({
        status: "ROLLED_BACK",
        restoredSafely: true,
      }),
    );
  });

  it.each([
    {
      name: "redirect target",
      alias: {
        redirect: "flight-map-redirected.vercel.app",
        redirectStatusCode: null,
      },
      evidence: {
        restoredAliasRedirect: "flight-map-redirected.vercel.app",
        restoredAliasRedirectStatusCode: null,
      },
    },
    {
      name: "redirect status",
      alias: {
        redirect: null,
        redirectStatusCode: 308,
      },
      evidence: {
        restoredAliasRedirect: null,
        restoredAliasRedirectStatusCode: 308,
      },
    },
  ])("records BLOCKED for rollback $name mismatch", async ({
    alias,
    evidence,
  }) => {
    const writeEvidence = vi.fn(async () => ({
      path: "artifacts/release-evidence/rollback.json",
      sha256: "f".repeat(64),
    }));
    let providerRequestCount = 0;

    await expect(
      promoteProductionCandidate(environment, {
        loadExpectation: async () => expectation,
        verifyImmutable: async () => immutableEvidence(),
        providerRequest: async () => {
          providerRequestCount += 1;
          if (providerRequestCount === 1) {
            return {
              id: expectation.priorAliasDeploymentId,
              url: "flight-map-previous.vercel.app",
              projectId: expectation.projectId,
              ownerId: expectation.orgId,
              readyState: "READY",
            } as never;
          }
          return {
            alias: expectation.productionAlias,
            deploymentId: expectation.priorAliasDeploymentId,
            projectId: expectation.projectId,
            ...alias,
          } as never;
        },
        runCli: (async () => ({ stdout: "" })) as never,
        verifyAlias: async () => {
          throw new Error("post-promotion health failed");
        },
        writeEvidence: writeEvidence as never,
        challenge: () => "e".repeat(43),
      }),
    ).rejects.toThrow(/restoration was not verified/);

    expect(writeEvidence).toHaveBeenCalledWith(
      expect.any(String),
      "production-rollback",
      expect.objectContaining({
        status: "BLOCKED",
        restoredSafely: false,
        ...evidence,
      }),
    );
  });

  it("records BLOCKED when prior-alias restoration cannot be verified", async () => {
    const writeEvidence = vi.fn(async () => ({
      path: "artifacts/release-evidence/rollback.json",
      sha256: "f".repeat(64),
    }));
    let cliCalls = 0;

    await expect(
      promoteProductionCandidate(environment, {
        loadExpectation: async () => expectation,
        verifyImmutable: async () => immutableEvidence(),
        providerRequest: async () =>
          ({
            id: expectation.priorAliasDeploymentId,
            url: "flight-map-previous.vercel.app",
            projectId: expectation.projectId,
            ownerId: expectation.orgId,
            readyState: "READY",
          }) as never,
        runCli: (async () => {
          cliCalls += 1;
          if (cliCalls === 2) {
            throw new Error("restore failed");
          }
          return { stdout: "" };
        }) as never,
        verifyAlias: async () => {
          throw new Error("post-promotion health failed");
        },
        writeEvidence: writeEvidence as never,
        challenge: () => "e".repeat(43),
      }),
    ).rejects.toThrow(/restoration was not verified/);

    expect(writeEvidence).toHaveBeenCalledWith(
      expect.any(String),
      "production-rollback",
      expect.objectContaining({
        status: "BLOCKED",
        restoredSafely: false,
      }),
    );
  });
});
