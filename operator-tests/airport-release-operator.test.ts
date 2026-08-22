import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSnapshotAttestation,
  queryNeonSnapshotProviderState,
  runNeonCli,
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
  it.each(["0014", "0015", "0016", "0017"] as const)(
    "accepts the supported %s migration boundary",
    (migrationBoundary) => {
      expect(() =>
        createSnapshotAttestation(verifiedInput({
          target: {
            ...target,
            migrationBoundary,
          },
        })),
      ).not.toThrow();
    },
  );

  it("rejects an unsupported migration boundary", () => {
    expect(() =>
      createSnapshotAttestation(verifiedInput({
        target: {
          ...target,
          migrationBoundary: "0018",
        } as OperatorTargetInspection,
      })),
    ).toThrow();
  });

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

  it("executes the npx neonctl pair through a Windows child process", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const scratch = path.resolve(
      import.meta.dirname,
      `.neon-child-${process.pid}-${Date.now()}`,
    );
    const executable = path.join(scratch, "npx.cmd");
    await mkdir(scratch, { recursive: true });
    await writeFile(executable, "@echo {\"projects\":[]}\r\n", "ascii");
    try {
      await expect(
        runNeonCli(
          executable,
          ["--yes", "neonctl"],
          ["projects", "list", "--output", "json"],
        ),
      ).resolves.toContain('{"projects":[]}');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("parses multi-line JSON from the Node gate", async () => {
    const scratch = path.resolve(
      import.meta.dirname,
      `.json-node-${process.pid}-${Date.now()}`,
    );
    const script = path.join(scratch, "output.ts");
    await mkdir(scratch, { recursive: true });
    await writeFile(
      script,
      'console.log(JSON.stringify({ status: "ready" }, null, 2));\n',
      "utf8",
    );
    try {
      const runner = path.resolve(
        import.meta.dirname,
        "../ops/finish-airport-production-release.ps1",
      );
      const tsx = path.resolve(
        import.meta.dirname,
        "../node_modules/tsx/dist/cli.mjs",
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-Command",
          `
$source = Get-Content -Raw -LiteralPath '${runner.replaceAll("'", "''")}'
$functionSource = [regex]::Match(
  $source,
  '(?s)function Invoke-JsonNode.+?(?=\\r?\\nfunction Invoke-ReleaseNode)'
).Value
Invoke-Expression $functionSource
$tsx = '${tsx.replaceAll("'", "''")}'
$result = Invoke-JsonNode '${script.replaceAll("'", "''")}' @()
$result | ConvertTo-Json -Compress
`,
        ],
        { encoding: "utf8", cwd: path.resolve(import.meta.dirname, "..") },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: "ready",
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

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
    expect(script).toContain("$failureMessage = $neonAuthAction");
    expect(script).toContain('"neonctl auth"');
    expect(script).toContain('"npx --yes neonctl auth"');
    expect(script).toContain('$failureMessage = "vercel login"');
    expect(script).toContain('"provider-verify"');
    expect(script).toContain('"--neon-prefix-arg"');
    expect(script).toContain('"--restore-prefix-arg"');
    expect(script).toContain("--provider-branch-base64");
    expect(script).toContain("--provider-endpoints-base64");
    expect(script).not.toContain("--created-at");
    expect(script).not.toContain("operator-console-branch-id");
    expect(script.indexOf('Read-Host "Neon snapshot branch ID"')).toBeLessThan(
      script.indexOf('"provider-verify"'),
    );
    expect(
      script.indexOf(
        '$failureMessage -eq "neonctl auth"',
      ),
    ).toBeLessThan(script.indexOf("$operatorStatus = if"));
    expect(
      script.indexOf('$stage = "Vercel provider verification"'),
    ).toBeGreaterThan(script.indexOf('$stage = "artifact verification"'));
    expect(
      script.indexOf('$stage = "Vercel provider verification"'),
    ).toBeLessThan(script.indexOf('$stage = "Neon authentication"'));
    expect(script).toContain(
      "git status --porcelain --untracked-files=all",
    );
    expect(script).toContain(
      '"https://github.com/giffdev/waypointer"',
    );
    expect(script.indexOf('$stage = "artifact verification"')).toBeLessThan(
      script.indexOf('$stage = "Neon authentication"'),
    );
    expect(script.indexOf("$releaseStarted = $true")).toBeLessThan(
      script.indexOf("Invoke-ReleaseNode $releaseScript"),
    );
    expect(
      script.indexOf('Remove-Item -Path "Env:NEON_API_KEY"'),
    ).toBeLessThan(script.indexOf("git worktree add --detach"));
    expect(script).toContain('"VERCEL_TOKEN"');
    expect(script).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+/i);
  });

  it("records an npx restore command without leaking authentication", () => {
    const attestation = createSnapshotAttestation(verifiedInput({
      restoreExecutable: "npx",
      restoreArgumentsPrefix: ["--yes", "neonctl"],
    }));

    expect(attestation.restoreProcedure.restoreCommand).toEqual({
      executable: "npx",
      args: [
        "--yes",
        "neonctl",
        "branches",
        "restore",
        providerBranch.parent_id,
        providerBranch.id,
        "--project-id",
        providerBranch.project_id,
      ],
    });
  });
});
