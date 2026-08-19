import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  canonicalJson,
  sha256Bytes,
  writeContentAddressedJson,
} from "../scripts/airport-release-provenance.ts";
import {
  airportDatabaseTargetFingerprint,
  REQUIRED_ROLLBACK_STOP_CONDITIONS,
} from "../scripts/airport-release-safety.ts";
import {
  snapshotAirportReleaseState,
} from "../scripts/airport-release-rollback.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "../scripts/postgres-diagnostics.ts";

const root = path.resolve(import.meta.dirname, "..");
const SNAPSHOT_MAX_AGE_MS = 20 * 60 * 1000;

export interface OperatorTargetInspection {
  targetFingerprint: string;
  databaseName: string;
  databaseOid: number;
  preChangeStateSha256: string;
  migrationBoundary: string;
  inspectedAt: string;
}

export interface SnapshotAttestationInput {
  snapshotId: string;
  createdAt: string;
  verifiedAt: string;
  target: OperatorTargetInspection;
  restoreExecutable?: "neon" | "neonctl";
  neonProjectId?: string;
  productionBranchId?: string;
}

function validSnapshotId(value: string): boolean {
  return /^br-[a-z0-9-]{3,240}$/.test(value);
}

function validInspection(value: OperatorTargetInspection): boolean {
  return Boolean(
    /^[a-f0-9]{64}$/.test(value.targetFingerprint) &&
      value.databaseName &&
      Number.isSafeInteger(value.databaseOid) &&
      value.databaseOid > 0 &&
      /^[a-f0-9]{64}$/.test(value.preChangeStateSha256) &&
      ["0014", "0015"].includes(value.migrationBoundary) &&
      Number.isFinite(Date.parse(value.inspectedAt)),
  );
}

export function createSnapshotAttestation(
  input: SnapshotAttestationInput,
) {
  const createdAt = Date.parse(input.createdAt);
  const verifiedAt = Date.parse(input.verifiedAt);
  if (
    !validSnapshotId(input.snapshotId) ||
    !validInspection(input.target) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(verifiedAt) ||
    createdAt > verifiedAt ||
    verifiedAt - createdAt > SNAPSHOT_MAX_AGE_MS
  ) {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
  const snapshotCore = {
    provider: "neon",
    id: input.snapshotId,
    targetFingerprint: input.target.targetFingerprint,
    databaseName: input.target.databaseName,
    databaseOid: input.target.databaseOid,
    preChangeStateSha256: input.target.preChangeStateSha256,
    createdAt: new Date(createdAt).toISOString(),
    verification:
      input.neonProjectId && input.productionBranchId
        ? {
            mode: "authenticated-neon-cli",
            projectId: input.neonProjectId,
            parentBranchId: input.productionBranchId,
          }
        : {
            mode: "operator-console-branch-id",
          },
  };
  const restoreExecutable = input.restoreExecutable ?? "neon";
  const restoreArgs =
    input.neonProjectId && input.productionBranchId
      ? [
          "branches",
          "restore",
          input.productionBranchId,
          input.snapshotId,
          "--project-id",
          input.neonProjectId,
        ]
      : [
          "branches",
          "restore",
          "production",
          input.snapshotId,
        ];
  return {
    schemaVersion: 1 as const,
    ...snapshotCore,
    sha256: sha256Bytes(canonicalJson(snapshotCore)),
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(verifiedAt + SNAPSHOT_MAX_AGE_MS).toISOString(),
    restoreProcedure: {
      schemaVersion: 1 as const,
      stopConditions: [...REQUIRED_ROLLBACK_STOP_CONDITIONS],
      transactionSemantics: "serializable-database-release" as const,
      stagingSemantics:
        "live-production-alias-read-only-control-plane" as const,
      restoreCommand: {
        executable: restoreExecutable,
        args: restoreArgs,
      },
      verificationCommand: {
        executable: "npm.cmd" as const,
        args: ["run", "db:airport-rollback-verify"],
      },
    },
  };
}

async function inspectTarget(): Promise<OperatorTargetInspection> {
  const migrationDatabaseUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ?? "";
  if (!migrationDatabaseUrl) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  const client = postgres(migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const [connected] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    if (
      !connected?.database_name ||
      !Number.isSafeInteger(connected.database_oid) ||
      connected.database_oid <= 0
    ) {
      throw new AirportCatalogSafetyError("database-target-mismatch");
    }
    const state = await snapshotAirportReleaseState(
      client,
      "production",
    );
    return {
      targetFingerprint:
        airportDatabaseTargetFingerprint(migrationDatabaseUrl),
      databaseName: connected.database_name,
      databaseOid: connected.database_oid,
      preChangeStateSha256: state.stateSha256,
      migrationBoundary: state.migration.boundary,
      inspectedAt: new Date().toISOString(),
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

function requireArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  return value;
}

async function createAttestation() {
  const expected = {
    targetFingerprint: requireArgument("--target-fingerprint"),
    databaseName: requireArgument("--database-name"),
    databaseOid: Number(requireArgument("--database-oid")),
    preChangeStateSha256: requireArgument("--pre-change-state-sha256"),
  };
  const target = await inspectTarget();
  if (
    target.targetFingerprint !== expected.targetFingerprint ||
    target.databaseName !== expected.databaseName ||
    target.databaseOid !== expected.databaseOid ||
    target.preChangeStateSha256 !== expected.preChangeStateSha256
  ) {
    throw new AirportCatalogSafetyError("database-target-mismatch");
  }
  const attestation = createSnapshotAttestation({
    snapshotId: requireArgument("--snapshot-id"),
    createdAt: requireArgument("--created-at"),
    verifiedAt: target.inspectedAt,
    target,
    restoreExecutable:
      process.argv.includes("--restore-with-neonctl")
        ? "neonctl"
        : "neon",
    neonProjectId:
      process.argv.includes("--neon-project-id")
        ? requireArgument("--neon-project-id")
        : undefined,
    productionBranchId:
      process.argv.includes("--production-branch-id")
        ? requireArgument("--production-branch-id")
        : undefined,
  });
  const artifact = await writeContentAddressedJson(
    path.join(root, "data", "private", "release-approvals"),
    "neon-production-snapshot",
    attestation,
  );
  return {
    path: path.relative(root, artifact.path),
    sha256: artifact.sha256,
    snapshotId: attestation.id,
    targetFingerprint: attestation.targetFingerprint,
    databaseName: attestation.databaseName,
    databaseOid: attestation.databaseOid,
    preChangeStateSha256: attestation.preChangeStateSha256,
    verifiedAt: attestation.verifiedAt,
    expiresAt: attestation.expiresAt,
  };
}

async function main() {
  const command = process.argv[2];
  const result =
    command === "inspect"
      ? await inspectTarget()
      : command === "attest"
        ? await createAttestation()
        : undefined;
  if (!result) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  process.stdout.write(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(formatSafePostgresError(error));
    process.exitCode = 1;
  });
}
