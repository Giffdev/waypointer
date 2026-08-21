import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";
import {
  canonicalJson,
  createCandidateManifest,
  sha256Bytes,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import type { UnsafeSqlClient } from "./airport-release-migrations.ts";
import { snapshotAirportReleaseState } from "./airport-release-rollback.ts";
import { airportDatabaseTargetFingerprint } from "./airport-release-safety.ts";
import { safePostgresClientOptions } from "./postgres-diagnostics.ts";

const root = path.resolve(import.meta.dirname, "..");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Local release preparation is unavailable in production.");
  }
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("A local database URL is required.");
  const parsed = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname)
  ) {
    throw new Error("Local release preparation requires loopback PostgreSQL.");
  }
  const evidenceDirectory = path.join(
    root,
    "artifacts",
    "release-evidence",
    "airport-catalog",
  );
  const candidate = await writeContentAddressedJson(
    evidenceDirectory,
    "candidate",
    await createCandidateManifest(),
  );
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    const [database] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    const preChangeState = await snapshotAirportReleaseState(
      client as unknown as UnsafeSqlClient,
      "test",
    );
    const now = Date.now();
    const pausedAt = new Date(now - 3_000);
    const pauseVerifiedAt = new Date(now - 2_000);
    const snapshotCreatedAt = new Date(now - 1_500);
    const snapshotVerifiedAt = new Date(now - 1_000);
    const approvedAt = new Date(now - 500);
    const expiresAt = new Date(now + 3_600_000);
    const snapshotId = "flight-map-local";
    const restoreProcedure = {
      schemaVersion: 1,
      stopConditions: [
        "database-release-post-commit-health-failed",
        "deployment-attestation-mismatch",
        "evidence-persistence-failed",
        "promotion-health-failed",
      ],
      transactionSemantics: "serializable-database-release",
      stagingSemantics: "live-production-alias-read-only-control-plane",
      restoreCommand: {
        executable: "docker",
        args: [
          "compose",
          "-p",
          snapshotId,
          "down",
          "--volumes",
          "--remove-orphans",
        ],
      },
      verificationCommand: {
        executable: "npm",
        args: ["run", "db:airport-rollback-verify"],
      },
    };
    const approval = await writeContentAddressedJson(
      path.join(root, "data", "private", "release-approvals", "local"),
      "approval",
      {
        schemaVersion: 3,
        approvalId: `local-${database.database_oid}-${candidate.sha256.slice(0, 12)}`,
        environment: "test",
        targetFingerprint: airportDatabaseTargetFingerprint(databaseUrl),
        databaseName: database.database_name,
        databaseOid: database.database_oid,
        candidateManifestSha256: candidate.sha256,
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        changeControl: {
          mechanism: "application-read-only-plus-database-barrier",
          staging: "live-production-alias-read-only-control-plane",
          pauseEvidenceSha256: createHash("sha256")
            .update(`local-write-pause:${database.database_oid}`)
            .digest("hex"),
          importsPausedAt: pausedAt.toISOString(),
          verifiedAt: pauseVerifiedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        snapshot: {
          id: snapshotId,
          sha256: preChangeState.stateSha256,
          preChangeStateSha256: preChangeState.stateSha256,
          restoreProcedureSha256:
            sha256Bytes(canonicalJson(restoreProcedure)),
          createdAt: snapshotCreatedAt.toISOString(),
          verifiedAt: snapshotVerifiedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          restoreProcedure,
        },
      },
    );
    process.stdout.write(JSON.stringify({
      candidateManifestPath: candidate.path,
      candidateManifestSha256: candidate.sha256,
      targetApprovalPath: approval.path,
      targetApprovalSha256: approval.sha256,
      evidenceDirectory,
    }));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch(() => {
  process.stderr.write("Local airport release preparation failed.\n");
  process.exitCode = 1;
});
