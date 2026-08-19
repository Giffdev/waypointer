import { execFile } from "node:child_process";
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

export interface NeonSnapshotVerificationInput {
  snapshotId: string;
  verifiedAt: string;
  expectedNeonProjectId: string;
  expectedProductionBranchId: string;
  providerBranch: unknown;
  providerEndpoints: unknown;
}

export interface SnapshotAttestationInput
  extends NeonSnapshotVerificationInput {
  target: OperatorTargetInspection;
  restoreExecutable?: "neonctl" | "npx";
  restoreArgumentsPrefix?: readonly string[];
}

interface NeonProviderBranch {
  id: string;
  project_id: string;
  parent_id: string;
  created_at: string;
  current_state: string;
}

interface NeonProviderEndpoint {
  id: string;
  project_id: string;
  branch_id: string;
  current_state: string;
  type: string;
  disabled: boolean;
  pending_state?: string | null;
}

export interface VerifiedNeonSnapshot {
  id: string;
  projectId: string;
  parentBranchId: string;
  createdAt: string;
  branchState: "ready";
  endpointId: string;
  endpointState: "active" | "idle";
  endpointType: "read_write";
}

export interface NeonProviderPayload {
  branch: NeonProviderBranch;
  endpoints: NeonProviderEndpoint[];
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

function providerBranch(value: unknown): NeonProviderBranch | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const branch = value as Record<string, unknown>;
  if (
    typeof branch.id !== "string" ||
    typeof branch.project_id !== "string" ||
    typeof branch.parent_id !== "string" ||
    typeof branch.created_at !== "string" ||
    typeof branch.current_state !== "string"
  ) {
    return undefined;
  }
  return branch as unknown as NeonProviderBranch;
}

function providerEndpoints(value: unknown): NeonProviderEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const endpoint = candidate as Record<string, unknown>;
    if (
      typeof endpoint.id !== "string" ||
      typeof endpoint.project_id !== "string" ||
      typeof endpoint.branch_id !== "string" ||
      typeof endpoint.current_state !== "string" ||
      typeof endpoint.type !== "string" ||
      typeof endpoint.disabled !== "boolean" ||
      (
        endpoint.pending_state !== undefined &&
        endpoint.pending_state !== null &&
        typeof endpoint.pending_state !== "string"
      )
    ) {
      return [];
    }
    return [endpoint as unknown as NeonProviderEndpoint];
  });
}

export function verifyNeonSnapshotProviderState(
  input: NeonSnapshotVerificationInput,
): VerifiedNeonSnapshot {
  const branch = providerBranch(input.providerBranch);
  const endpoints = providerEndpoints(input.providerEndpoints);
  const createdAt = branch ? Date.parse(branch.created_at) : Number.NaN;
  const verifiedAt = Date.parse(input.verifiedAt);
  const endpoint = endpoints
    .filter(
      (candidate) =>
        candidate.branch_id === input.snapshotId &&
        candidate.project_id === input.expectedNeonProjectId &&
        /^ep-[a-z0-9-]{3,240}$/.test(candidate.id) &&
        candidate.type === "read_write" &&
        ["active", "idle"].includes(candidate.current_state) &&
        !candidate.disabled &&
        !candidate.pending_state,
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (
    !validSnapshotId(input.snapshotId) ||
    !/^[a-z0-9-]{1,60}$/.test(input.expectedNeonProjectId) ||
    !validSnapshotId(input.expectedProductionBranchId) ||
    !branch ||
    branch.id !== input.snapshotId ||
    branch.project_id !== input.expectedNeonProjectId ||
    branch.parent_id !== input.expectedProductionBranchId ||
    branch.current_state !== "ready" ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(verifiedAt) ||
    createdAt > verifiedAt ||
    verifiedAt - createdAt > SNAPSHOT_MAX_AGE_MS ||
    !endpoint
  ) {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
  return {
    id: branch.id,
    projectId: branch.project_id,
    parentBranchId: branch.parent_id,
    createdAt: new Date(createdAt).toISOString(),
    branchState: "ready",
    endpointId: endpoint.id,
    endpointState: endpoint.current_state as "active" | "idle",
    endpointType: "read_write",
  };
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
}

function providerCollection(
  value: unknown,
  property: string,
): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const collection = (value as Record<string, unknown>)[property];
    if (Array.isArray(collection)) {
      return collection;
    }
  }
  throw new AirportCatalogSafetyError("snapshot-approval-missing");
}

export async function queryNeonSnapshotProviderState(
  input: Omit<
    NeonSnapshotVerificationInput,
    "providerBranch" | "providerEndpoints"
  >,
  runNeon: (arguments_: readonly string[]) => Promise<string>,
): Promise<NeonProviderPayload> {
  try {
    if (
      !/^[a-z0-9-]{1,60}$/.test(input.expectedNeonProjectId) ||
      !validSnapshotId(input.expectedProductionBranchId) ||
      !validSnapshotId(input.snapshotId) ||
      !Number.isFinite(Date.parse(input.verifiedAt))
    ) {
      throw new AirportCatalogSafetyError("snapshot-approval-missing");
    }
    const projects = providerCollection(
      parsedJson(await runNeon([
        "projects",
        "list",
        "--output",
        "json",
      ])),
      "projects",
    );
    if (
      projects.filter(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          (candidate as Record<string, unknown>).id ===
            input.expectedNeonProjectId,
      ).length !== 1
    ) {
      throw new AirportCatalogSafetyError("snapshot-approval-missing");
    }
    const branches = providerCollection(
      parsedJson(await runNeon([
        "branches",
        "list",
        "--project-id",
        input.expectedNeonProjectId,
        "--output",
        "json",
      ])),
      "branches",
    );
    const productionBranch = branches.filter(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).id ===
          input.expectedProductionBranchId &&
        (candidate as Record<string, unknown>).project_id ===
          input.expectedNeonProjectId &&
        (candidate as Record<string, unknown>).current_state ===
          "ready",
    );
    const snapshotBranch = branches.filter(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>).id === input.snapshotId,
    );
    if (productionBranch.length !== 1 || snapshotBranch.length !== 1) {
      throw new AirportCatalogSafetyError("snapshot-approval-missing");
    }
    const endpointResponse = parsedJson(await runNeon([
      "api",
      `/projects/${input.expectedNeonProjectId}/endpoints`,
    ]));
    const endpoints = providerCollection(
      endpointResponse,
      "endpoints",
    );
    const payload = {
      branch: snapshotBranch[0],
      endpoints,
    };
    verifyNeonSnapshotProviderState({
      ...input,
      providerBranch: payload.branch,
      providerEndpoints: payload.endpoints,
    });
    return payload as NeonProviderPayload;
  } catch {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
}

export function createSnapshotAttestation(
  input: SnapshotAttestationInput,
) {
  const verifiedSnapshot = verifyNeonSnapshotProviderState(input);
  const verifiedAt = Date.parse(input.verifiedAt);
  if (
    !validInspection(input.target) ||
    !Number.isFinite(verifiedAt)
  ) {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
  const snapshotCore = {
    provider: "neon",
    id: verifiedSnapshot.id,
    targetFingerprint: input.target.targetFingerprint,
    databaseName: input.target.databaseName,
    databaseOid: input.target.databaseOid,
    preChangeStateSha256: input.target.preChangeStateSha256,
    createdAt: verifiedSnapshot.createdAt,
    verification: {
      mode: "authenticated-neon-cli",
      projectId: verifiedSnapshot.projectId,
      parentBranchId: verifiedSnapshot.parentBranchId,
      branchId: verifiedSnapshot.id,
      branchState: verifiedSnapshot.branchState,
      endpointId: verifiedSnapshot.endpointId,
      endpointState: verifiedSnapshot.endpointState,
      endpointType: verifiedSnapshot.endpointType,
    },
  };
  const restoreExecutable = input.restoreExecutable ?? "neonctl";
  const restoreArgumentsPrefix = input.restoreArgumentsPrefix ?? [];
  if (
    !["neonctl", "npx"].includes(restoreExecutable) ||
    (
      restoreExecutable === "neonctl" &&
      restoreArgumentsPrefix.length !== 0
    ) ||
    (
      restoreExecutable === "npx" &&
      (
        restoreArgumentsPrefix.length !== 2 ||
        restoreArgumentsPrefix[0] !== "--yes" ||
        restoreArgumentsPrefix[1] !== "neonctl"
      )
    )
  ) {
    throw new AirportCatalogSafetyError("snapshot-approval-missing");
  }
  const restoreArgs = [
    ...restoreArgumentsPrefix,
    "branches",
    "restore",
    verifiedSnapshot.parentBranchId,
    verifiedSnapshot.id,
    "--project-id",
    verifiedSnapshot.projectId,
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

function argumentsFor(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1]?.trim() ?? "";
      if (!value) {
        throw new AirportCatalogSafetyError(
          "target-configuration-invalid",
        );
      }
      values.push(value);
    }
  }
  return values;
}

function requireBase64JsonArgument(name: string): unknown {
  try {
    return JSON.parse(
      Buffer.from(requireArgument(name), "base64").toString("utf8"),
    );
  } catch {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
}

export function runNeonCli(
  executable: string,
  prefixArguments: readonly string[],
  arguments_: readonly string[],
): Promise<string> {
  const executableName = path.basename(executable).toLowerCase();
  const isNeonctl =
    /^neonctl(?:\.cmd|\.exe)?$/u.test(executableName) &&
    prefixArguments.length === 0;
  const isNpx =
    /^npx(?:\.cmd|\.exe)?$/u.test(executableName) &&
    prefixArguments.length === 2 &&
    prefixArguments[0] === "--yes" &&
    prefixArguments[1] === "neonctl";
  if (!isNeonctl && !isNpx) {
    return Promise.reject(
      new AirportCatalogSafetyError("snapshot-approval-missing"),
    );
  }
  const allArguments = [...prefixArguments, ...arguments_];
  return new Promise((resolve, reject) => {
    const commandIsCmd =
      process.platform === "win32" && executableName.endsWith(".cmd");
    const childExecutable = commandIsCmd
      ? process.env.ComSpec ?? "cmd.exe"
      : executable;
    const childArguments = commandIsCmd
      ? ["/d", "/s", "/c", "call", executable, ...allArguments]
      : allArguments;
    execFile(
      childExecutable,
      childArguments,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new AirportCatalogSafetyError(
              "snapshot-approval-missing",
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function verifyProviderSnapshot() {
  const attempts = Number(requireArgument("--attempts"));
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 15) {
    throw new AirportCatalogSafetyError("target-configuration-invalid");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const payload = await queryNeonSnapshotProviderState(
        {
          snapshotId: requireArgument("--snapshot-id"),
          verifiedAt: new Date().toISOString(),
          expectedNeonProjectId: requireArgument("--neon-project-id"),
          expectedProductionBranchId: requireArgument(
            "--production-branch-id",
          ),
        },
        (arguments_) =>
          runNeonCli(
            requireArgument("--neon-executable"),
            argumentsFor("--neon-prefix-arg"),
            arguments_,
          ),
      );
      return {
        branch: payload.branch,
        endpoints: payload.endpoints.map((endpoint) => ({
          id: endpoint.id,
          project_id: endpoint.project_id,
          branch_id: endpoint.branch_id,
          current_state: endpoint.current_state,
          type: endpoint.type,
          disabled: endpoint.disabled,
          pending_state: endpoint.pending_state ?? null,
        })),
      };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  throw lastError;
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
    verifiedAt: target.inspectedAt,
    target,
    restoreExecutable: requireArgument(
      "--restore-executable",
    ) as "neonctl" | "npx",
    restoreArgumentsPrefix: argumentsFor(
      "--restore-prefix-arg",
    ),
    expectedNeonProjectId: requireArgument("--neon-project-id"),
    expectedProductionBranchId: requireArgument(
      "--production-branch-id",
    ),
    providerBranch: requireBase64JsonArgument(
      "--provider-branch-base64",
    ),
    providerEndpoints: requireBase64JsonArgument(
      "--provider-endpoints-base64",
    ),
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
      : command === "provider-verify"
        ? await verifyProviderSnapshot()
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
