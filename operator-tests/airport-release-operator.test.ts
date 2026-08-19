import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSnapshotAttestation,
  queryNeonSnapshotProviderState,
  type OperatorTargetInspection,
} from "../ops/airport-release-operator.ts";
import {
  canonicalJson,
  sha256Bytes,
} from "../scripts/airport-release-provenance.ts";

const target: OperatorTargetInspection = {
  targetFingerprint: "a".repeat(64),
  databaseName: "flight_map",
  databaseOid: 16_384,
  preChangeStateSha256: "b".repeat(64),
  migrationBoundary: "0014",
  inspectedAt: "2026-08-19T00:50:10.000Z",
};

const providerBranch = {
  id: "br-airport-release-123",
  project_id: "project-airport-123",
  parent_id: "br-production-123",
  created_at: "2026-08-19T00:50:00.000Z",
  current_state: "ready",
};

const providerEndpoints = [{
  id: "ep-airport-release-123",
  project_id: providerBranch.project_id,
  branch_id: providerBranch.id,
  current_state: "active",
  type: "read_write",
  disabled: false,
  pending_state: null,
}];

function verifiedInput(
  overrides: Partial<Parameters<typeof createSnapshotAttestation>[0]> = {},
): Parameters<typeof createSnapshotAttestation>[0] {
  return {
    snapshotId: providerBranch.id,
    verifiedAt: "2026-08-19T00:50:10.000Z",
    target,
    restoreExecutable: "neonctl",
    expectedNeonProjectId: providerBranch.project_id,
    expectedProductionBranchId: providerBranch.parent_id,
    providerBranch,
    providerEndpoints,
    ...overrides,
  };
}

describe("guided airport release operator", () => {
  it("rejects an arbitrary pasted br-ID absent from provider data", () => {
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        snapshotId: "br-arbitrary-pasted-999",
      })),
    ).toThrow();
  });

  it.each([
    ["project", {
      providerBranch: {
        ...providerBranch,
        project_id: "project-wrong-999",
      },
    }],
    ["parent", {
      providerBranch: {
        ...providerBranch,
        parent_id: "br-wrong-parent-999",
      },
    }],
  ])("rejects a provider %s mismatch", (_label, overrides) => {
    expect(() =>
      createSnapshotAttestation(verifiedInput(overrides)),
    ).toThrow();
  });

  it("rejects a provider branch that is not Ready", () => {
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        providerBranch: {
          ...providerBranch,
          current_state: "creating",
        },
      })),
    ).toThrow();
  });

  it("rejects missing or unready compute endpoints", () => {
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        providerEndpoints: [],
      })),
    ).toThrow();
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        providerEndpoints: [{
          ...providerEndpoints[0],
          current_state: "creating",
        }],
      })),
    ).toThrow();
  });

  it("binds provider creation time instead of a caller guess", () => {
    const guessedInput = {
      ...verifiedInput(),
      createdAt: "2026-08-19T00:50:09.999Z",
    };
    const attestation = createSnapshotAttestation(guessedInput);

    expect(attestation.createdAt).toBe(providerBranch.created_at);
    expect(attestation.createdAt).not.toBe(guessedInput.createdAt);
  });

  it("rejects stale provider branches and provider payload failure", () => {
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        providerBranch: {
          ...providerBranch,
          created_at: "2026-08-19T00:20:00.000Z",
        },
      })),
    ).toThrow();
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        providerBranch: {},
      })),
    ).toThrow();
  });

  it("queries the authenticated Neon API for endpoint readiness", async () => {
    const calls: string[][] = [];
    const payload = await queryNeonSnapshotProviderState(
      {
        snapshotId: providerBranch.id,
        verifiedAt: "2026-08-19T00:50:10.000Z",
        expectedNeonProjectId: providerBranch.project_id,
        expectedProductionBranchId: providerBranch.parent_id,
      },
      async (arguments_) => {
        calls.push([...arguments_]);
        if (arguments_[0] === "projects") {
          return JSON.stringify([{ id: providerBranch.project_id }]);
        }
        if (arguments_[0] === "branches") {
          return JSON.stringify([
            {
              id: providerBranch.parent_id,
              project_id: providerBranch.project_id,
              current_state: "ready",
            },
            providerBranch,
          ]);
        }
        return JSON.stringify({ endpoints: providerEndpoints });
      },
    );

    expect(calls).toEqual([
      ["projects", "list", "--output", "json"],
      [
        "branches",
        "list",
        "--project-id",
        providerBranch.project_id,
        "--output",
        "json",
      ],
      [
        "api",
        `/projects/${providerBranch.project_id}/endpoints`,
      ],
    ]);
    expect(payload.branch).toEqual(providerBranch);
    expect(payload.endpoints).toEqual(providerEndpoints);
  });

  it("rejects an authenticated Neon provider query failure", async () => {
    await expect(
      queryNeonSnapshotProviderState(
        {
          snapshotId: providerBranch.id,
          verifiedAt: "2026-08-19T00:50:10.000Z",
          expectedNeonProjectId: providerBranch.project_id,
          expectedProductionBranchId: providerBranch.parent_id,
        },
        async () => {
          throw new Error("provider unavailable");
        },
      ),
    ).rejects.toThrow();
  });

  it("creates a fully provider-verified Neon branch attestation", () => {
    const attestation = createSnapshotAttestation(verifiedInput());
    const expectedCore = {
      provider: "neon",
      id: providerBranch.id,
      targetFingerprint: target.targetFingerprint,
      databaseName: target.databaseName,
      databaseOid: target.databaseOid,
      preChangeStateSha256: target.preChangeStateSha256,
      createdAt: providerBranch.created_at,
      verification: {
        mode: "authenticated-neon-cli",
        projectId: providerBranch.project_id,
        parentBranchId: providerBranch.parent_id,
        branchId: providerBranch.id,
        branchState: "ready",
        endpointId: providerEndpoints[0].id,
        endpointState: "active",
        endpointType: "read_write",
      },
    };

    expect(attestation.verification).toEqual(expectedCore.verification);
    expect(attestation.restoreProcedure.restoreCommand).toEqual({
      executable: "neonctl",
      args: [
        "branches",
        "restore",
        providerBranch.parent_id,
        providerBranch.id,
        "--project-id",
        providerBranch.project_id,
      ],
    });
    expect(attestation.restoreProcedure.verificationCommand).toEqual({
      executable: "npm.cmd",
      args: ["run", "db:airport-rollback-verify"],
    });
    expect(attestation.sha256).toBe(
      sha256Bytes(canonicalJson(expectedCore)),
    );
    expect(canonicalJson(attestation)).not.toMatch(
      /postgres(?:ql)?:\/\/|password|authorization|cookie|api[_-]?key/i,
    );
  });

  it("keeps secrets transient and requires typed release confirmation", async () => {
    const scriptPath = path.resolve(
      import.meta.dirname,
      "../ops/finish-airport-production-release.ps1",
    );
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("Read-Host -Prompt $Prompt -AsSecureString");
    expect(script).toContain("ZeroFreeBSTR");
    expect(script).toContain('\"RELEASE $($approvalResult.approvalSha256)\"');
    expect(script).toContain("finally {");
    expect(script).toContain('"MIGRATION_DATABASE_URL"');
    expect(script).toContain(
      "AIRPORT_RELEASE_SNAPSHOT_ATTESTATION_SHA256",
    );
    expect(script).toContain("git worktree add --detach");
    expect(script).toContain("git worktree remove --force");
    expect(script).toContain('$failureMessage = "neonctl auth"');
    expect(script).toContain('"provider-verify"');
    expect(script).toContain("--provider-branch-base64");
    expect(script).toContain("--provider-endpoints-base64");
    expect(script).not.toContain("--created-at");
    expect(script).not.toContain("operator-console-branch-id");
    expect(script.indexOf('Read-Host "Neon snapshot branch ID"')).toBeLessThan(
      script.indexOf('"provider-verify"'),
    );
    expect(
      script.indexOf('if ($failureMessage -eq "neonctl auth")'),
    ).toBeLessThan(script.indexOf("$operatorStatus = if"));
    expect(script.indexOf('$stage = "Neon authentication"')).toBeLessThan(
      script.indexOf('$stage = "artifact verification"'),
    );
    expect(script.indexOf("$releaseStarted = $true")).toBeLessThan(
      script.indexOf("Invoke-ReleaseNode $releaseScript"),
    );
    expect(
      script.indexOf('Remove-Item -Path "Env:NEON_API_KEY"'),
    ).toBeLessThan(script.indexOf("git worktree add --detach"));
    expect(script).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+/i);
  });

  it("stops the normal path with only the exact auth action", () => {
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const result = spawnSync(
      shell,
      [
        "-NoProfile",
        "-File",
        path.resolve(
          import.meta.dirname,
          "../ops/finish-airport-production-release.ps1",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NEON_API_KEY: "",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr.trim()).toBe("neonctl auth");
  });
});
