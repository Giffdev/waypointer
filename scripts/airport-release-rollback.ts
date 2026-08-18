import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  type AirportMigrationState,
  type UnsafeSqlClient,
  verifyAirportMigrationState,
} from "./airport-release-migrations.ts";
import {
  canonicalJson,
  sha256Bytes,
  writeContentAddressedJson,
} from "./airport-release-provenance.ts";
import {
  AIRPORT_ROLLBACK_CONFIRMATION_PREFIX,
  type AirportReleaseTarget,
  type AirportRollbackStopCondition,
  requireAirportReleaseTarget,
} from "./airport-release-safety.ts";
import {
  AirportCatalogSafetyError,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics.ts";

export interface RelationStateFingerprint {
  present: boolean;
  count: number;
  sha256: string;
}

export const AIRPORT_RELEASE_MUTABLE_RELATIONS = [
  "airports",
  "airport_aliases",
  "flights",
  "flight_stops",
  "import_batches",
  "import_rows",
  "flight_sources",
  "flight_overrides",
  "duplicate_candidates",
  "map_shares",
] as const;

export const AIRPORT_RELEASE_ROLLBACK_RELATIONS = [
  ...AIRPORT_RELEASE_MUTABLE_RELATIONS,
  "drizzle_migrations",
] as const;

type AirportReleaseRollbackRelation =
  (typeof AIRPORT_RELEASE_ROLLBACK_RELATIONS)[number];

export interface AirportReleaseStateFingerprint {
  schemaVersion: 3;
  migration: AirportMigrationState;
  relations: Record<
    AirportReleaseRollbackRelation,
    RelationStateFingerprint
  >;
  stateSha256: string;
}

interface DatabaseReleaseEvidence {
  status?: string;
  candidate?: { manifestSha256?: string };
  target?: {
    fingerprint?: string;
    approvalSha256?: string;
  };
  snapshot?: {
    id?: string;
    preChangeState?: AirportReleaseStateFingerprint;
  };
}

const RELATION_QUERIES = {
  airports: {
    relation: "public.airports",
    query: "select to_jsonb(value) as value from public.airports value order by id",
  },
  airport_aliases: {
    relation: "public.airport_aliases",
    query: "select to_jsonb(value) as value from public.airport_aliases value order by airport_id, code, code_type",
  },
  flights: {
    relation: "public.flights",
    query: "select to_jsonb(value) as value from public.flights value order by id",
  },
  flight_stops: {
    relation: "public.flight_stops",
    query: "select to_jsonb(value) as value from public.flight_stops value order by flight_id, stop_order",
  },
  import_batches: {
    relation: "public.import_batches",
    query: "select to_jsonb(value) as value from public.import_batches value order by id",
  },
  import_rows: {
    relation: "public.import_rows",
    query: "select to_jsonb(value) as value from public.import_rows value order by id",
  },
  flight_sources: {
    relation: "public.flight_sources",
    query: "select to_jsonb(value) as value from public.flight_sources value order by id",
  },
  flight_overrides: {
    relation: "public.flight_overrides",
    query: "select to_jsonb(value) as value from public.flight_overrides value order by id",
  },
  duplicate_candidates: {
    relation: "public.duplicate_candidates",
    query: "select to_jsonb(value) as value from public.duplicate_candidates value order by id",
  },
  map_shares: {
    relation: "public.map_shares",
    query: "select to_jsonb(value) as value from public.map_shares value order by user_id",
  },
  drizzle_migrations: {
    relation: "drizzle.__drizzle_migrations",
    query: "select to_jsonb(value) as value from drizzle.__drizzle_migrations value order by id",
  },
} as const satisfies Record<
  AirportReleaseRollbackRelation,
  { relation: string; query: string }
>;

function assertRelationQueryInventory() {
  if (
    canonicalJson(Object.keys(RELATION_QUERIES)) !==
    canonicalJson(AIRPORT_RELEASE_ROLLBACK_RELATIONS)
  ) {
    throw new AirportCatalogSafetyError("rollback-verification-failed");
  }
}

function assertCompleteStateFingerprint(
  state: AirportReleaseStateFingerprint,
  diagnosticCode: "rollback-not-eligible" | "rollback-verification-failed",
) {
  const relationNames = Object.keys(state.relations).sort();
  const expectedRelationNames = [
    ...AIRPORT_RELEASE_ROLLBACK_RELATIONS,
  ].sort();
  const validRelations =
    relationNames.length === expectedRelationNames.length &&
    relationNames.every(
      (relation, index) => relation === expectedRelationNames[index],
    ) &&
    AIRPORT_RELEASE_ROLLBACK_RELATIONS.every((relation) => {
      const fingerprint = state.relations[relation];
      return (
        typeof fingerprint?.present === "boolean" &&
        Number.isSafeInteger(fingerprint.count) &&
        fingerprint.count >= 0 &&
        /^[a-f0-9]{64}$/.test(fingerprint.sha256)
      );
    });
  const stateCore = {
    schemaVersion: 3 as const,
    migration: state.migration,
    relations: state.relations,
  };
  if (
    state.schemaVersion !== 3 ||
    !validRelations ||
    sha256Bytes(canonicalJson(stateCore)) !== state.stateSha256
  ) {
    throw new AirportCatalogSafetyError(diagnosticCode);
  }
}

async function relationExists(
  sql: UnsafeSqlClient,
  relation: string,
): Promise<boolean> {
  const [row] = await sql.unsafe(
    "select to_regclass($1) is not null as present",
    [relation],
  );
  return row?.present === true;
}

async function hashRelation(
  sql: UnsafeSqlClient,
  relation: AirportReleaseRollbackRelation,
): Promise<RelationStateFingerprint> {
  const definition = RELATION_QUERIES[relation];
  if (!(await relationExists(sql, definition.relation))) {
    return {
      present: false,
      count: 0,
      sha256: sha256Bytes(""),
    };
  }
  const rows = await sql.unsafe(definition.query);
  const digest = rows
    .map((row) => JSON.stringify(row.value))
    .join("\n");
  return {
    present: true,
    count: rows.length,
    sha256: sha256Bytes(digest),
  };
}

export async function snapshotAirportReleaseState(
  sql: UnsafeSqlClient,
  environment: "production" | "test",
): Promise<AirportReleaseStateFingerprint> {
  assertRelationQueryInventory();
  const migration = await verifyAirportMigrationState(sql, environment);
  const relationEntries = await Promise.all(
    AIRPORT_RELEASE_ROLLBACK_RELATIONS.map(async (relation) => [
      relation,
      await hashRelation(sql, relation),
    ]),
  );
  const relations = Object.fromEntries(relationEntries) as Record<
    AirportReleaseRollbackRelation,
    RelationStateFingerprint
  >;
  const stateCore = {
    schemaVersion: 3 as const,
    migration,
    relations,
  };
  const fingerprint = {
    ...stateCore,
    stateSha256: sha256Bytes(canonicalJson(stateCore)),
  };
  assertCompleteStateFingerprint(
    fingerprint,
    "rollback-verification-failed",
  );
  return fingerprint;
}

export function assertAirportRollbackEligible(
  target: AirportReleaseTarget,
  evidence: DatabaseReleaseEvidence,
  evidenceSha256: string,
  trigger: string,
  confirmation: string,
): AirportReleaseStateFingerprint {
  if (
    evidence.status !== "database-release-passed" ||
    evidence.candidate?.manifestSha256 !==
      target.candidateManifestSha256 ||
    evidence.target?.fingerprint !== target.fingerprint ||
    evidence.target?.approvalSha256 !== target.approvalSha256 ||
    evidence.snapshot?.id !== target.approval.snapshot.id ||
    !evidence.snapshot.preChangeState ||
    evidence.snapshot.preChangeState.stateSha256 !==
      target.approval.snapshot.preChangeStateSha256 ||
    !target.approval.snapshot.restoreProcedure.stopConditions.includes(
      trigger as AirportRollbackStopCondition,
    ) ||
    confirmation !==
      `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${target.approvalSha256}:${evidenceSha256}`
  ) {
    throw new AirportCatalogSafetyError("rollback-not-eligible");
  }
  assertCompleteStateFingerprint(
    evidence.snapshot.preChangeState,
    "rollback-not-eligible",
  );
  return evidence.snapshot.preChangeState;
}

export async function verifyRestoredAirportState(
  sql: UnsafeSqlClient,
  environment: "production" | "test",
  expected: AirportReleaseStateFingerprint,
): Promise<AirportReleaseStateFingerprint> {
  assertCompleteStateFingerprint(
    expected,
    "rollback-verification-failed",
  );
  const actual = await snapshotAirportReleaseState(sql, environment);
  assertCompleteStateFingerprint(
    actual,
    "rollback-verification-failed",
  );
  if (actual.stateSha256 !== expected.stateSha256) {
    throw new AirportCatalogSafetyError("rollback-verification-failed");
  }
  return actual;
}

async function main() {
  const target = requireAirportReleaseTarget();
  const evidencePath =
    process.env.AIRPORT_RELEASE_DATABASE_EVIDENCE_PATH?.trim() ?? "";
  const evidenceSha256 =
    process.env.AIRPORT_RELEASE_DATABASE_EVIDENCE_SHA256?.trim() ?? "";
  const resolvedEvidencePath = path.resolve(evidencePath);
  const permittedRoot = path.resolve(target.evidenceDirectory);
  let evidence: DatabaseReleaseEvidence;
  try {
    if (
      !resolvedEvidencePath.startsWith(`${permittedRoot}${path.sep}`) ||
      path.extname(resolvedEvidencePath).toLowerCase() !== ".json"
    ) {
      throw new Error("path");
    }
    const contents = await readFile(resolvedEvidencePath);
    if (
      !/^[a-f0-9]{64}$/.test(evidenceSha256) ||
      sha256Bytes(contents) !== evidenceSha256
    ) {
      throw new Error("hash");
    }
    evidence = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new AirportCatalogSafetyError("candidate-provenance-mismatch");
  }
  const expected = assertAirportRollbackEligible(
    target,
    evidence,
    evidenceSha256,
    process.env.AIRPORT_RELEASE_ROLLBACK_TRIGGER?.trim() ?? "",
    process.env.AIRPORT_RELEASE_ROLLBACK_CONFIRMATION?.trim() ?? "",
  );
  const client = postgres(target.migrationDatabaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...safePostgresClientOptions,
  });
  try {
    const restored = await verifyRestoredAirportState(
      client as unknown as UnsafeSqlClient,
      target.approval.environment,
      expected,
    );
    const artifact = await writeContentAddressedJson(
      target.evidenceDirectory,
      "airport-rollback-verification",
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        status: "rollback-verified",
        candidateManifestSha256: target.candidateManifestSha256,
        targetFingerprint: target.fingerprint,
        targetApprovalSha256: target.approvalSha256,
        databaseEvidenceSha256: evidenceSha256,
        snapshotId: target.approval.snapshot.id,
        restored,
        requiresFreshTargetApprovalBeforeRetry: true,
      },
    );
    console.log(`Airport rollback verified: sha256=${artifact.sha256}.`);
  } finally {
    await client.end({ timeout: 5 });
  }
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
