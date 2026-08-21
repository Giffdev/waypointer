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
] as const;

export const AIRPORT_RELEASE_ROLLBACK_RELATIONS = [
  ...AIRPORT_RELEASE_MUTABLE_RELATIONS,
  "drizzle_migrations",
] as const;

export type AirportReleaseRollbackRelation =
  (typeof AIRPORT_RELEASE_ROLLBACK_RELATIONS)[number];

export interface AirportReleaseStateFingerprint {
  schemaVersion: 4;
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

const RELATION_DEFINITIONS = {
  airports: {
    relation: "public.airports",
  },
  airport_aliases: {
    relation: "public.airport_aliases",
  },
  drizzle_migrations: {
    relation: "drizzle.__drizzle_migrations",
  },
} as const satisfies Record<
  AirportReleaseRollbackRelation,
  { relation: string }
>;

function assertRelationQueryInventory() {
  if (
    canonicalJson(Object.keys(RELATION_DEFINITIONS)) !==
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
    schemaVersion: 4 as const,
    migration: state.migration,
    relations: state.relations,
  };
  if (
    state.schemaVersion !== 4 ||
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

export function airportReleaseRelationFingerprintQuery(
  relation: AirportReleaseRollbackRelation,
): string {
  const { relation: qualifiedRelation } = RELATION_DEFINITIONS[relation];
  return `
    select
      count(*)::text as row_count,
      encode(
        sha256(
          convert_to(
            coalesce(
              string_agg(
                encode(sha256(convert_to(row_json, 'UTF8')), 'hex'),
                ''
                order by row_json
              ),
              ''
            ),
            'UTF8'
          )
        ),
        'hex'
      ) as row_fingerprint
    from (
      select to_jsonb(value)::text as row_json
      from ${qualifiedRelation} value
    ) relation_rows
  `;
}

export async function fingerprintAirportReleaseRelation(
  sql: UnsafeSqlClient,
  relation: AirportReleaseRollbackRelation,
): Promise<RelationStateFingerprint> {
  const definition = RELATION_DEFINITIONS[relation];
  if (!(await relationExists(sql, definition.relation))) {
    return {
      present: false,
      count: 0,
      sha256: sha256Bytes(""),
    };
  }
  const [aggregate] = await sql.unsafe(
    airportReleaseRelationFingerprintQuery(relation),
  );
  const rawCount = aggregate?.row_count;
  const fingerprint = aggregate?.row_fingerprint;
  if (
    typeof rawCount !== "string" ||
    !/^(0|[1-9]\d*)$/.test(rawCount) ||
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fingerprint)
  ) {
    throw new AirportCatalogSafetyError("rollback-verification-failed");
  }
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count)) {
    throw new AirportCatalogSafetyError("rollback-verification-failed");
  }
  return {
    present: true,
    count,
    sha256: fingerprint,
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
      await fingerprintAirportReleaseRelation(sql, relation),
    ]),
  );
  const relations = Object.fromEntries(relationEntries) as Record<
    AirportReleaseRollbackRelation,
    RelationStateFingerprint
  >;
  const stateCore = {
    schemaVersion: 4 as const,
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
