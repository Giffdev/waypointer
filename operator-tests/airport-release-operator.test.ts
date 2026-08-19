import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSnapshotAttestation,
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

describe("guided airport release operator", () => {
  it("creates a credential-free Neon branch attestation", () => {
    const attestation = createSnapshotAttestation({
      snapshotId: "br-airport-release-123",
      createdAt: "2026-08-19T00:50:00.000Z",
      verifiedAt: "2026-08-19T00:50:10.000Z",
      target,
    });

    expect(attestation.restoreProcedure.restoreCommand).toEqual({
      executable: "neon",
      args: [
        "branches",
        "restore",
        "production",
        "br-airport-release-123",
      ],
    });
    expect(attestation.restoreProcedure.verificationCommand).toEqual({
      executable: "npm.cmd",
      args: ["run", "db:airport-rollback-verify"],
    });
    expect(attestation.sha256).toBe(
      sha256Bytes(
        canonicalJson({
          provider: "neon",
          id: "br-airport-release-123",
          targetFingerprint: target.targetFingerprint,
          databaseName: target.databaseName,
          databaseOid: target.databaseOid,
          preChangeStateSha256: target.preChangeStateSha256,
          createdAt: "2026-08-19T00:50:00.000Z",
          verification: {
            mode: "operator-console-branch-id",
          },
        }),
      ),
    );
    expect(canonicalJson(attestation)).not.toMatch(
      /postgres(?:ql)?:\/\/|password|authorization|cookie/i,
    );
  });

  it("rejects an unbound or stale snapshot identifier", () => {
    expect(() =>
      createSnapshotAttestation({
        snapshotId: "not-a-neon-branch",
        createdAt: "2026-08-19T00:00:00.000Z",
        verifiedAt: "2026-08-19T00:50:10.000Z",
        target,
      }),
    ).toThrow();
  });

  it("binds authenticated Neon verification to the restore command", () => {
    const attestation = createSnapshotAttestation({
      snapshotId: "br-airport-release-456",
      createdAt: "2026-08-19T00:50:00.000Z",
      verifiedAt: "2026-08-19T00:50:10.000Z",
      target,
      neonProjectId: "project-airport-123",
      productionBranchId: "br-production-123",
    });

    expect(attestation.verification).toEqual({
      mode: "authenticated-neon-cli",
      projectId: "project-airport-123",
      parentBranchId: "br-production-123",
    });
    expect(attestation.restoreProcedure.restoreCommand.args).toEqual([
      "branches",
      "restore",
      "br-production-123",
      "br-airport-release-456",
      "--project-id",
      "project-airport-123",
    ]);
  });

  it("keeps secrets transient and requires typed release confirmation", async () => {
    const script = await readFile(
      path.resolve(
        import.meta.dirname,
        "../ops/finish-airport-production-release.ps1",
      ),
      "utf8",
    );

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
    expect(script.indexOf("$releaseStarted = $true")).toBeLessThan(
      script.indexOf("Invoke-ReleaseNode $releaseScript"),
    );
    expect(
      script.indexOf('Remove-Item -Path "Env:NEON_API_KEY"'),
    ).toBeLessThan(script.indexOf("git worktree add --detach"));
    expect(script).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+/i);
  });
});
