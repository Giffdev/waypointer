import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeDb } from "../src/lib/db/index";
import {
  canonicalJson,
  createCandidateManifest,
  sha256Bytes,
  writeContentAddressedJson,
} from "./airport-release-provenance";
import {
  assertAirportRollbackEligible,
  snapshotAirportReleaseState,
  verifyRestoredAirportState,
} from "./airport-release-rollback";
import {
  airportDatabaseTargetFingerprint,
  AIRPORT_RELEASE_CONFIRMATION_PREFIX,
  AIRPORT_ROLLBACK_CONFIRMATION_PREFIX,
  type AirportReleaseTarget,
} from "./airport-release-safety";
import {
  loadAirportReleaseMigrations,
  type UnsafeSqlClient,
} from "./airport-release-migrations";
import {
  runAirportCatalogRelease,
  type AirportReleaseFailureStage,
} from "./release-airport-catalog";
import { safePostgresClientOptions } from "./postgres-diagnostics";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS === "true" &&
  Boolean(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const root = process.cwd();
const databaseName = `flight_map_airport_upgrade_${process.pid}`;
const snapshotDatabaseName =
  `flight_map_airport_snapshot_${process.pid}`;
const secondSnapshotDatabaseName =
  `flight_map_airport_snapshot_second_${process.pid}`;
const fixtureDirectory = path.join(
  root,
  "artifacts",
  "release-evidence",
  "airport-catalog",
  `upgrade-${process.pid}`,
);
const approvalDirectory = path.join(
  root,
  "data",
  "private",
  "release-approvals",
  `upgrade-${process.pid}`,
);
const userId = randomUUID();
const legacyIds = {
  totalRf: randomUUID(),
  tonasket: randomUUID(),
  omak: randomUUID(),
  forks: randomUUID(),
  quillayute: randomUUID(),
};
const historicalFlightId = randomUUID();
const batchId = randomUUID();
const rowId = randomUUID();
const flightOverrideId = randomUUID();
const duplicateCandidateId = randomUUID();
let releaseEnvironment: NodeJS.ProcessEnv;
let wrongDatabaseEnvironment: NodeJS.ProcessEnv;
let originalDatabaseUrl: string | undefined;
let originalMigrationDatabaseUrl: string | undefined;
let successfulRelease: Awaited<ReturnType<typeof runAirportCatalogRelease>>;
let legacyValidationArtifactSha256 = "";
const mutableRollbackResults: Record<
  string,
  {
    mutationRejected: true;
    restoredStateSha256: string;
    exactEquality: true;
  }
> = {};

function adminUrl() {
  const source =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const parsed = new URL(source);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function fixtureDatabaseUrl() {
  const parsed = new URL(
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  );
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** The token drizzle's migrator splits migration files on. */
const STATEMENT_BREAKPOINT = ["--", "> statement-breakpoint"].join("");

/** The newest reviewed migration — the schema the application requires. */
async function newestMigrationTag(): Promise<string> {
  const migrations = await loadAirportReleaseMigrations();
  const newest = migrations.at(-1);
  if (!newest) throw new Error("The migration manifest is empty.");
  return newest.tag;
}

/** Boundary name for the newest reviewed migration, e.g. "0018". */
async function newestMigrationBoundary(): Promise<string> {
  return (await newestMigrationTag()).slice(0, 4);
}

/**
 * Seeds the fixture database up to and including `finalTag`.
 *
 * The rehearsal used to stop at 0014 so the release itself would apply 0015.
 * That state is no longer reachable in production: the release executes
 * application code (airport reconciliation reads flights and import rows
 * through the repository), so the database it runs against must already carry
 * the schema the deployed application requires. A database still at 0014
 * could not serve the application at all, let alone be reconciled by it.
 *
 * The "does the release apply pending migrations, and only the reviewed ones"
 * behaviour is covered directly, and without this coupling, by
 * `scripts/airport-release-migrations.test.ts`.
 */
async function applyMigrationsThrough(
  client: ReturnType<typeof postgres>,
  finalTag: string,
) {
  const migrations = await loadAirportReleaseMigrations();
  await client.unsafe("create schema if not exists drizzle");
  await client.unsafe(`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  const [ledger] = await client<Array<{ count: number }>>`
    select count(*)::integer as count from drizzle.__drizzle_migrations
  `;
  for (const migration of migrations.slice(ledger.count)) {
    const sql = await readFile(
      path.join(root, "drizzle", "migrations", `${migration.tag}.sql`),
      "utf8",
    );
    for (const statement of sql.split(STATEMENT_BREAKPOINT)) {
      if (statement.trim()) await client.unsafe(statement);
    }
    await client.unsafe(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       values ($1, $2)`,
      [migration.sha256, migration.createdAt],
    );
    if (migration.tag === finalTag) return;
  }
  throw new Error("Requested migration boundary was not found.");
}

async function insertLegacyFixture(client: ReturnType<typeof postgres>) {
  await client.unsafe(
    `insert into users (id, email, username, email_verified_at)
     values ($1, $2, $3, now())`,
    [userId, `${userId}@example.test`, `upgrade_${userId.slice(0, 8)}`],
  );
  const airports = [
    [
      legacyIds.totalRf,
      "K00A",
      null,
      "00A",
      "Total RF Heliport",
      "Bensalem",
      40.070985,
      -74.933689,
    ],
    [
      legacyIds.tonasket,
      "KW01",
      null,
      "W01",
      "Tonasket Municipal Airport",
      "Tonasket",
      48.7248683333,
      -119.465634722,
    ],
    [
      legacyIds.omak,
      "KOMK",
      "OMK",
      "OMK",
      "Omak Airport",
      "Omak",
      48.4644012451,
      -119.517997742,
    ],
    [
      legacyIds.forks,
      null,
      null,
      "S18",
      "Forks Airport",
      "Forks",
      47.937698,
      -124.396004,
    ],
    [
      legacyIds.quillayute,
      "KUIL",
      "UIL",
      "UIL",
      "Quillayute Airport",
      "Quillayute",
      47.936599731445,
      -124.56300354004,
    ],
  ];
  for (const airport of airports) {
    await client.unsafe(
      `insert into airports (
         id, icao, iata, local_code, name, city, country,
         latitude, longitude, facility, dataset_version
       ) values ($1, $2, $3, $4, $5, $6, 'US', $7, $8, 'general-aviation', 'legacy-airports')`,
      airport,
    );
  }
  await client.unsafe(
    `insert into flights (
       id, user_id, fingerprint, date, origin_airport_id,
       destination_airport_id, kind, role, role_origin, source_type
     ) values ($1, $2, $3, '2026-08-01', $4, $5, 'private', 'pilot', 'explicit', 'Manual')`,
    [
      historicalFlightId,
      userId,
      randomUUID(),
      legacyIds.totalRf,
      legacyIds.tonasket,
    ],
  );
  await client.unsafe(
    `insert into flight_overrides (
       id, user_id, flight_id, field, original_value,
       corrected_value, actor, reason
     ) values ($1, $2, $3, 'role', '"passenger"'::jsonb,
       '"pilot"'::jsonb, 'user', 'legacy correction')`,
    [flightOverrideId, userId, historicalFlightId],
  );
}

async function insertUnresolvedImport(client: ReturnType<typeof postgres>) {
  const proposedFlight = {
    date: "2026-08-02",
    originIdentifier: "W01",
    destinationIdentifier: "OMK",
    origin: { status: "not-found", identifier: "W01" },
    destination: { status: "not-found", identifier: "OMK" },
    kind: "private",
    role: "pilot",
    source: "ForeFlight",
    classificationOrigin: "source-default",
  };
  const stored = {
    id: rowId,
    batchId,
    rowNumber: 1,
    proposedFlight,
    issues: [],
    validationState: "unresolved",
    commitReady: false,
    decision: "pending",
    provenance: {
      adapterId: "foreflight-v1",
      adapterLabel: "ForeFlight Logbook Import",
      adapterVersion: 1,
      source: "ForeFlight",
      sourceRowNumber: 1,
    },
  };
  await client.unsafe(
    `insert into import_batches (
       id, user_id, adapter_id, adapter_version, status,
       original_object_key, original_file_name, file_sha256,
       file_size_bytes, total_rows, parsed_rows, expires_at
     ) values (
       $1, $2, 'foreflight-v1', 1, 'review',
       'test/upgrade.csv', 'upgrade.csv', $3,
       100, 1, 1, now() + interval '1 day'
     )`,
    [batchId, userId, "c".repeat(64)],
  );
  await client.unsafe(
    `insert into import_rows (
       id, user_id, batch_id, row_number, raw_snapshot, parsed,
       validation_state, proposed_flight, user_decision
     ) values ($1, $2, $3, 1, $4::jsonb, $5::jsonb, 'invalid', $6::jsonb, 'pending')`,
    [
      rowId,
      userId,
      batchId,
      JSON.stringify(["2026-08-02", "W01", "OMK"]),
      JSON.stringify(stored),
      JSON.stringify(proposedFlight),
    ],
  );
  await client.unsafe(
    `insert into duplicate_candidates (
       id, user_id, batch_id, import_row_id, candidate_flight_id,
       candidate_scope, rule_version, score, explanation
     ) values (
       $1, $2, $3, $4, $5, 'existing-flight', 1, 0.75,
       '{"rule":"legacy-review"}'::jsonb
     )`,
    [
      duplicateCandidateId,
      userId,
      batchId,
      rowId,
      historicalFlightId,
    ],
  );
}

beforeAll(async () => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
  const admin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    await admin.unsafe(`drop database if exists "${databaseName}"`);
    await admin.unsafe(
      `drop database if exists "${snapshotDatabaseName}"`,
    );
    await admin.unsafe(
      `drop database if exists "${secondSnapshotDatabaseName}"`,
    );
    await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const client = postgres(fixtureDatabaseUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  let database: { database_name: string; database_oid: number };
  let preChangeState: Awaited<
    ReturnType<typeof snapshotAirportReleaseState>
  >;
  try {
    await applyMigrationsThrough(client, "0008_read_only_map_sharing");
    await insertLegacyFixture(client);
    await insertUnresolvedImport(client);
    // Up to the application's own schema. The release runs application code,
    // so this is the only boundary a real deployment can present.
    await applyMigrationsThrough(client, await newestMigrationTag());
    [database] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    preChangeState = await snapshotAirportReleaseState(
      client as unknown as UnsafeSqlClient,
      "test",
    );
  } finally {
    await client.end();
  }
  const snapshotAdmin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    await snapshotAdmin.unsafe(
      `create database "${snapshotDatabaseName}" template "${databaseName}"`,
    );
  } finally {
    await snapshotAdmin.end();
  }
  const candidate = await writeContentAddressedJson(
    fixtureDirectory,
    "candidate",
    await createCandidateManifest(),
  );
  const now = Date.now();
  const snapshotId = snapshotDatabaseName;
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
      executable: "createdb",
      args: ["--template", snapshotId, databaseName],
    },
    verificationCommand: {
      executable: "npm",
      args: ["run", "db:airport-rollback-verify"],
    },
  };
  const approvalPayload = {
    schemaVersion: 3,
    approvalId: `upgrade-${process.pid}`,
    environment: "test",
    targetFingerprint:
      airportDatabaseTargetFingerprint(fixtureDatabaseUrl()),
    databaseName: database.database_name,
    databaseOid: database.database_oid,
    candidateManifestSha256: candidate.sha256,
    approvedAt: new Date(now - 500).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    changeControl: {
      mechanism: "application-read-only-plus-database-barrier",
      staging: "live-production-alias-read-only-control-plane",
      pauseEvidenceSha256: createHash("sha256")
        .update(`pause:${database.database_oid}`)
        .digest("hex"),
      importsPausedAt: new Date(now - 4_000).toISOString(),
      verifiedAt: new Date(now - 3_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    },
    snapshot: {
      id: snapshotId,
      sha256: createHash("sha256")
        .update(`${snapshotId}:${preChangeState.stateSha256}`)
        .digest("hex"),
      preChangeStateSha256: preChangeState.stateSha256,
      restoreProcedureSha256:
        sha256Bytes(canonicalJson(restoreProcedure)),
      createdAt: new Date(now - 2_000).toISOString(),
      verifiedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      restoreProcedure,
    },
  };
  const approval = await writeContentAddressedJson(
    approvalDirectory,
    "approval",
    approvalPayload,
  );
  releaseEnvironment = {
    ...process.env,
    DATABASE_URL: fixtureDatabaseUrl(),
    MIGRATION_DATABASE_URL: fixtureDatabaseUrl(),
    AIRPORT_RELEASE_TARGET_APPROVAL_PATH: approval.path,
    AIRPORT_RELEASE_TARGET_APPROVAL_SHA256: approval.sha256,
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_PATH: candidate.path,
    AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256: candidate.sha256,
    AIRPORT_RELEASE_CONFIRMATION:
      AIRPORT_RELEASE_CONFIRMATION_PREFIX + approval.sha256,
    AIRPORT_RELEASE_EVIDENCE_DIRECTORY: fixtureDirectory,
  };
  const wrongDatabaseApproval = await writeContentAddressedJson(
    approvalDirectory,
    "approval",
    {
      ...approvalPayload,
      approvalId: `wrong-database-${process.pid}`,
      databaseOid: database.database_oid + 1,
    },
  );
  wrongDatabaseEnvironment = {
    ...releaseEnvironment,
    AIRPORT_RELEASE_TARGET_APPROVAL_PATH: wrongDatabaseApproval.path,
    AIRPORT_RELEASE_TARGET_APPROVAL_SHA256:
      wrongDatabaseApproval.sha256,
    AIRPORT_RELEASE_CONFIRMATION:
      AIRPORT_RELEASE_CONFIRMATION_PREFIX +
      wrongDatabaseApproval.sha256,
  };
  process.env.DATABASE_URL = fixtureDatabaseUrl();
  process.env.MIGRATION_DATABASE_URL = fixtureDatabaseUrl();
}, 120_000);

afterAll(async () => {
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalMigrationDatabaseUrl === undefined) {
    delete process.env.MIGRATION_DATABASE_URL;
  } else {
    process.env.MIGRATION_DATABASE_URL = originalMigrationDatabaseUrl;
  }
  const admin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    await admin.unsafe(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = any($1::text[]) and pid <> pg_backend_pid()`,
      [[databaseName, snapshotDatabaseName, secondSnapshotDatabaseName]],
    );
    await admin.unsafe(`drop database if exists "${databaseName}"`);
    await admin.unsafe(
      `drop database if exists "${snapshotDatabaseName}"`,
    );
    await admin.unsafe(
      `drop database if exists "${secondSnapshotDatabaseName}"`,
    );
  } finally {
    await admin.end();
  }
  await Promise.all([
    rm(fixtureDirectory, { recursive: true, force: true }),
    rm(approvalDirectory, { recursive: true, force: true }),
  ]);
});

async function createSecondPassEnvironment() {
  const client = postgres(fixtureDatabaseUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  let database: { database_name: string; database_oid: number };
  let state: Awaited<ReturnType<typeof snapshotAirportReleaseState>>;
  try {
    [database] = await client<Array<{
      database_name: string;
      database_oid: number;
    }>>`
      select
        current_database() as database_name,
        (select oid::integer from pg_database where datname = current_database())
          as database_oid
    `;
    state = await snapshotAirportReleaseState(
      client as unknown as UnsafeSqlClient,
      "test",
    );
  } finally {
    await client.end();
  }
  const admin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    await admin.unsafe(
      `drop database if exists "${secondSnapshotDatabaseName}"`,
    );
    await admin.unsafe(
      `create database "${secondSnapshotDatabaseName}" template "${databaseName}"`,
    );
  } finally {
    await admin.end();
  }
  const now = Date.now();
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
      executable: "createdb",
      args: [
        "--template",
        secondSnapshotDatabaseName,
        databaseName,
      ],
    },
    verificationCommand: {
      executable: "npm",
      args: ["run", "db:airport-rollback-verify"],
    },
  };
  const approval = await writeContentAddressedJson(
    approvalDirectory,
    "approval",
    {
      schemaVersion: 3,
      approvalId: `upgrade-second-${process.pid}`,
      environment: "test",
      targetFingerprint:
        airportDatabaseTargetFingerprint(fixtureDatabaseUrl()),
      databaseName: database.database_name,
      databaseOid: database.database_oid,
      candidateManifestSha256:
        releaseEnvironment.AIRPORT_RELEASE_CANDIDATE_MANIFEST_SHA256,
      approvedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      changeControl: {
        mechanism: "application-read-only-plus-database-barrier",
        staging: "live-production-alias-read-only-control-plane",
        pauseEvidenceSha256: createHash("sha256")
          .update(`second-pause:${database.database_oid}`)
          .digest("hex"),
        importsPausedAt: new Date(now - 4_000).toISOString(),
        verifiedAt: new Date(now - 3_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
      },
      snapshot: {
        id: secondSnapshotDatabaseName,
        sha256: createHash("sha256")
          .update(`${secondSnapshotDatabaseName}:${state.stateSha256}`)
          .digest("hex"),
        preChangeStateSha256: state.stateSha256,
        restoreProcedureSha256:
          sha256Bytes(canonicalJson(restoreProcedure)),
        createdAt: new Date(now - 2_000).toISOString(),
        verifiedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        restoreProcedure,
      },
    },
  );
  return {
    ...releaseEnvironment,
    AIRPORT_RELEASE_TARGET_APPROVAL_PATH: approval.path,
    AIRPORT_RELEASE_TARGET_APPROVAL_SHA256: approval.sha256,
    AIRPORT_RELEASE_CONFIRMATION:
      AIRPORT_RELEASE_CONFIRMATION_PREFIX + approval.sha256,
  };
}

async function restoreFixtureFromApprovedSnapshot() {
  await closeDb();
  const admin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    ...safePostgresClientOptions,
  });
  try {
    await admin.unsafe(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.unsafe(`drop database "${databaseName}"`);
    await admin.unsafe(
      `create database "${databaseName}" template "${snapshotDatabaseName}"`,
    );
  } finally {
    await admin.end();
  }
}

postgresDescribe("production-like airport catalog upgrade", () => {
  it("suppresses an actual PostgreSQL notice containing unsafe details", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = postgres(fixtureDatabaseUrl(), {
      max: 1,
      prepare: false,
      ...safePostgresClientOptions,
    });

    try {
      await client.unsafe(`
        do $$
        begin
          raise notice 'insert into airports params=PRIVATE-ROW secret-token filename.csv user@example.test';
        end
        $$;
      `);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await client.end();
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it(
    "rejects the wrong approved database identity before writes",
    async () => {
      const client = postgres(fixtureDatabaseUrl(), {
        max: 1,
        prepare: false,
        ...safePostgresClientOptions,
      });
      try {
        const before = await snapshotAirportReleaseState(
          client as unknown as UnsafeSqlClient,
          "test",
        );
        await expect(
          runAirportCatalogRelease({
            environment: wrongDatabaseEnvironment,
          }),
        ).rejects.toMatchObject({
          diagnosticCode: "database-target-mismatch",
        });
        expect(
          await snapshotAirportReleaseState(
            client as unknown as UnsafeSqlClient,
            "test",
          ),
        ).toEqual(before);
      } finally {
        await client.end();
      }
    },
    120_000,
  );

  it.each([
    "after-migrations",
    "after-reconciliation",
  ] satisfies AirportReleaseFailureStage[])(
    "rolls back every database phase when failure is injected %s",
    async (failAfter) => {
      const client = postgres(fixtureDatabaseUrl(), {
        max: 1,
        prepare: false,
        ...safePostgresClientOptions,
        ...safePostgresClientOptions,
      });
      try {
        const before = await snapshotAirportReleaseState(
          client as unknown as UnsafeSqlClient,
          "test",
        );
        await expect(
          runAirportCatalogRelease({
            environment: releaseEnvironment,
            failAfter,
          }),
        ).rejects.toMatchObject({
          diagnosticCode: "health-check-failed",
        });
        expect(
          await snapshotAirportReleaseState(
            client as unknown as UnsafeSqlClient,
            "test",
          ),
        ).toEqual(before);
      } finally {
        await client.end();
      }
    },
    120_000,
  );

  it("preserves legacy UUIDs and FKs, reconciles imports, and is idempotent", async () => {
    const first = await runAirportCatalogRelease({
      environment: releaseEnvironment,
    });
    successfulRelease = first;
    expect(first.evidence.scope).toMatchObject({
      kind: "regional-airport-catalog-only",
      requiredBefore: "0014_fix_flight_share_invalidation",
      includedMigrations: ["0015_airport_source_provenance"],
      applicationPromotionIncluded: false,
    });
    // The database already carries the application's schema, so the release
    // applies nothing and the boundary is unchanged either side of it. That
    // the release *does* apply a pending reviewed migration when one exists is
    // asserted directly in scripts/airport-release-migrations.test.ts.
    const boundary = await newestMigrationBoundary();
    expect(first.evidence.migration.before.boundary).toBe(boundary);
    expect(first.evidence.migration.after.boundary).toBe(boundary);
    const secondEnvironment = await createSecondPassEnvironment();
    const second = await runAirportCatalogRelease({
      environment: secondEnvironment,
    });
    expect(first.evidence.catalog.identityChecksum).toBe(
      second.evidence.catalog.identityChecksum,
    );
    expect(second.evidence.identity).toMatchObject({
      matchedBySourceIdent: 85_836,
      matchedLegacy: 0,
      created: 0,
    });

    const client = postgres(fixtureDatabaseUrl(), {
      max: 1,
      prepare: false,
    });
    try {
      const [totalRf] = await client<Array<{
        id: string;
        source_ident: string;
      }>>`
        select id::text, source_ident
        from airports
        where source_ident = '00A'
      `;
      expect(totalRf).toEqual({
        id: legacyIds.totalRf,
        source_ident: "00A",
      });
      const [historicalFlight] = await client<Array<{
        origin_airport_id: string;
        destination_airport_id: string;
      }>>`
        select origin_airport_id::text, destination_airport_id::text
        from flights where id = ${historicalFlightId}
      `;
      expect(historicalFlight).toEqual({
        origin_airport_id: legacyIds.totalRf,
        destination_airport_id: legacyIds.tonasket,
      });
      const [batch] = await client<Array<{ status: string }>>`
        select status::text from import_batches where id = ${batchId}
      `;
      expect(batch.status).toBe("committed");
      const [source] = await client<Array<{ count: number }>>`
        select count(*)::integer as count
        from flight_sources
        where batch_id = ${batchId}
      `;
      expect(source.count).toBe(1);
      const stops = await client<Array<{
        stop_order: number;
        airport_id: string;
      }>>`
        select stop_order, airport_id::text
        from flight_stops
        where flight_id = ${historicalFlightId}
        order by stop_order
      `;
      expect(stops).toEqual([
        { stop_order: 0, airport_id: legacyIds.totalRf },
        { stop_order: 1, airport_id: legacyIds.tonasket },
      ]);
      const [defaults] = await client<Array<{
        distance_default: string;
        map_default: string;
      }>>`
        select
          max(column_default) filter (where column_name = 'distance_unit')
            as distance_default,
          max(column_default) filter (where column_name = 'map_view_mode')
            as map_default
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user_profiles'
      `;
      expect(defaults.distance_default).toContain("nautical_miles");
      expect(defaults.map_default).toContain("globe");
    } finally {
      await client.end();
    }

    const validationArtifact = await writeContentAddressedJson(
      path.join(
        root,
        "artifacts",
        "release-evidence",
        "airport-catalog",
      ),
      "airport-legacy-upgrade-validation",
      {
        schemaVersion: 2,
        status: "passed",
        scope: first.evidence.scope,
        candidateManifestSha256:
          first.evidence.candidate.manifestSha256,
        migrationManifestSha256:
          first.evidence.migration.manifestSha256,
        firstDatabaseEvidenceSha256: first.artifact.sha256,
        secondDatabaseEvidenceSha256: second.artifact.sha256,
        firstDatabaseRelease: first.evidence,
        secondDatabaseRelease: second.evidence,
        before: first.evidence.migration.before,
        after: first.evidence.migration.after,
        catalogChecksum: first.evidence.catalog.identityChecksum,
        rerunCatalogChecksum: second.evidence.catalog.identityChecksum,
        historicalFlights: first.evidence.historicalFlights,
        reconciliation: first.evidence.reconciliation,
        regional: first.evidence.regional,
        preChangeState: first.evidence.snapshot.preChangeState,
        secondPassPreChangeState:
          second.evidence.snapshot.preChangeState,
      },
    );
    legacyValidationArtifactSha256 = validationArtifact.sha256;
  }, 180_000);

  it.each([
    "airports",
    "airport_aliases",
  ] as const)(
    "rejects a mutated %s fingerprint, restores it, and proves exact equality",
    async (relation) => {
      const evidenceSha256 = successfulRelease.artifact.sha256;
      const target = {
        fingerprint: successfulRelease.evidence.target.fingerprint,
        candidateManifestSha256:
          successfulRelease.evidence.candidate.manifestSha256,
        approvalSha256:
          successfulRelease.evidence.target.approvalSha256,
        approval: {
          snapshot: {
            id: successfulRelease.evidence.snapshot.id,
            preChangeStateSha256:
              successfulRelease.evidence.snapshot.preChangeState.stateSha256,
            restoreProcedure: {
              stopConditions:
                successfulRelease.evidence.rollback.stopConditions,
            },
          },
        },
      } as unknown as AirportReleaseTarget;
      const expected = assertAirportRollbackEligible(
        target,
        successfulRelease.evidence,
        evidenceSha256,
        "promotion-health-failed",
        `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${target.approvalSha256}:${evidenceSha256}`,
      );

      await restoreFixtureFromApprovedSnapshot();
      let client = postgres(fixtureDatabaseUrl(), {
        max: 1,
        prepare: false,
        ...safePostgresClientOptions,
      });
      try {
        if (relation === "airports") {
          const [before] = await client<Array<{ name: string }>>`
            select name
            from airports
            where id = ${legacyIds.omak}
          `;
          expect(before.name).not.toBe("rollback mutation");
          await client`
            update airports
            set name = 'rollback mutation'
            where id = ${legacyIds.omak}
          `;
        } else {
          const [before] = await client<Array<{ id: string }>>`
            select id
            from airport_aliases
            where airport_id = ${legacyIds.omak}
            order by id
            limit 1
          `;
          expect(before.id).toMatch(/^[a-f0-9-]{36}$/);
          await client`
            delete from airport_aliases
            where id = ${before.id}
          `;
        }
        await expect(
          verifyRestoredAirportState(
            client as unknown as UnsafeSqlClient,
            "test",
            expected,
          ),
        ).rejects.toMatchObject({
          diagnosticCode: "rollback-verification-failed",
        });
      } finally {
        await client.end();
      }

      await restoreFixtureFromApprovedSnapshot();
      client = postgres(fixtureDatabaseUrl(), {
        max: 1,
        prepare: false,
        ...safePostgresClientOptions,
      });
      try {
        const restored = await verifyRestoredAirportState(
          client as unknown as UnsafeSqlClient,
          "test",
          expected,
        );
        expect(restored).toEqual(expected);
        mutableRollbackResults[relation] = {
          mutationRejected: true,
          restoredStateSha256: restored.stateSha256,
          exactEquality: true,
        };
      } finally {
        await client.end();
      }
    },
    120_000,
  );

  it("restores the approved pre-change snapshot only after eligibility and operator confirmation", async () => {
    expect(legacyValidationArtifactSha256).toMatch(/^[a-f0-9]{64}$/);
    const evidenceSha256 = successfulRelease.artifact.sha256;
    const target = {
      fingerprint: successfulRelease.evidence.target.fingerprint,
      candidateManifestSha256:
        successfulRelease.evidence.candidate.manifestSha256,
      approvalSha256:
        successfulRelease.evidence.target.approvalSha256,
      approval: {
        snapshot: {
          id: successfulRelease.evidence.snapshot.id,
          preChangeStateSha256:
            successfulRelease.evidence.snapshot.preChangeState.stateSha256,
          restoreProcedure: {
            stopConditions:
              successfulRelease.evidence.rollback.stopConditions,
          },
        },
      },
    } as unknown as AirportReleaseTarget;
    const expected = assertAirportRollbackEligible(
      target,
      successfulRelease.evidence,
      evidenceSha256,
      "promotion-health-failed",
      `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${target.approvalSha256}:${evidenceSha256}`,
    );

    await restoreFixtureFromApprovedSnapshot();
    const restoredClient = postgres(fixtureDatabaseUrl(), {
      max: 1,
      prepare: false,
      ...safePostgresClientOptions,
    });
    try {
      const restored = await verifyRestoredAirportState(
        restoredClient as unknown as UnsafeSqlClient,
        "test",
        expected,
      );
      expect(restored.migration.boundary).toBe(
        await newestMigrationBoundary(),
      );
      const [flight] = await restoredClient<Array<{
        origin_airport_id: string;
        destination_airport_id: string;
      }>>`
        select origin_airport_id::text, destination_airport_id::text
        from flights where id = ${historicalFlightId}
      `;
      expect(flight).toEqual({
        origin_airport_id: legacyIds.totalRf,
        destination_airport_id: legacyIds.tonasket,
      });
      // A partial restore that leaves a schema artifact behind must be
      // rejected. The drill used to add `source_ident_provenance`, which only
      // worked while the fixture sat at the 0014 ledger; the rehearsal now
      // starts from the application's own schema, where that column already
      // exists, so an unmistakably synthetic column stands in for the same
      // drift.
      await restoredClient.unsafe(
        `alter table airports
         add column rollback_drill_residue text`,
      );
      await expect(
        verifyRestoredAirportState(
          restoredClient as unknown as UnsafeSqlClient,
          "test",
          expected,
        ),
      ).rejects.toMatchObject({
        diagnosticCode: "schema-state-mismatch",
      });
      await writeContentAddressedJson(
        path.join(
          root,
          "artifacts",
          "release-evidence",
          "airport-catalog",
        ),
        "airport-rollback-drill",
        {
          schemaVersion: 3,
          status: "rollback-verified",
          scope: successfulRelease.evidence.scope,
          databaseEvidenceSha256: evidenceSha256,
          legacyValidationArtifactSha256,
          trigger: "promotion-health-failed",
          snapshotId: snapshotDatabaseName,
          restored,
          expected,
          partialRestoreMutation:
            "a stray airports column left behind after restore",
          partialRestoreRejected: true,
          mutableTableRestoration: mutableRollbackResults,
          requiresFreshTargetApprovalBeforeRetry: true,
        },
      );
    } finally {
      await restoredClient.end();
    }
  }, 120_000);
});
