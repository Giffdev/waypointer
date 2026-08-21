import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  sha256Bytes,
} from "./airport-release-provenance.ts";
import { AirportCatalogSafetyError } from "./postgres-diagnostics.ts";

const root = path.resolve(import.meta.dirname, "..");
const migrationsRoot = path.join(root, "drizzle", "migrations");
const releaseConfigPath = path.join(
  root,
  "config",
  "airport-catalog-release.json",
);

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

export interface AirportReleaseMigration {
  order: number;
  tag: string;
  createdAt: number;
  sha256: string;
}

export interface AirportMigrationBoundary {
  tag: string;
  appliedCount: number;
  ledgerSha256: string;
}

export interface AirportReleaseMigrationManifest {
  schemaVersion: 1;
  entries: AirportReleaseMigration[];
  permittedBefore: AirportMigrationBoundary[];
  expectedAfter: AirportMigrationBoundary;
}

export interface LoadedAirportReleaseMigrationManifest
  extends AirportReleaseMigrationManifest {
  sha256: string;
  releaseScope: AirportReleaseScope;
}

export interface AirportReleaseScope {
  schemaVersion: 1;
  kind: "regional-airport-catalog-only";
  requiredBefore: "0014_fix_flight_share_invalidation";
  includedMigrations: ["0015_airport_source_provenance"];
  databaseOperations: [
    "verify-target-ledger-schema-and-snapshot",
    "apply-0015-if-pending",
    "refresh-pinned-airports-and-aliases",
    "reconcile-unresolved-airport-imports",
    "verify-regional-identities-and-historical-flight-links",
    "persist-content-addressed-evidence",
  ];
  excludedMigrations: [
    "0009_airport_identifier_aliases",
    "0010_airport_name_search",
    "0011_nautical_miles_profile_default",
    "0012_multi_stop_flight_routes",
    "0013_map_view_mode_preference",
    "0014_fix_flight_share_invalidation",
  ];
  applicationPromotionIncluded: false;
}

export const AIRPORT_RELEASE_SCOPE: AirportReleaseScope = {
  schemaVersion: 1,
  kind: "regional-airport-catalog-only",
  requiredBefore: "0014_fix_flight_share_invalidation",
  includedMigrations: ["0015_airport_source_provenance"],
  databaseOperations: [
    "verify-target-ledger-schema-and-snapshot",
    "apply-0015-if-pending",
    "refresh-pinned-airports-and-aliases",
    "reconcile-unresolved-airport-imports",
    "verify-regional-identities-and-historical-flight-links",
    "persist-content-addressed-evidence",
  ],
  excludedMigrations: [
    "0009_airport_identifier_aliases",
    "0010_airport_name_search",
    "0011_nautical_miles_profile_default",
    "0012_multi_stop_flight_routes",
    "0013_map_view_mode_preference",
    "0014_fix_flight_share_invalidation",
  ],
  applicationPromotionIncluded: false,
};

export interface AirportMigrationState {
  boundary: "empty" | "0014" | "0015" | "0016" | "0017";
  appliedCount: number;
  ledgerSha256: string;
  schemaSha256: string;
  migrationManifestSha256: string;
}

export interface AirportMigrationLedgerRow {
  hash: unknown;
  created_at: unknown;
}

export function airportMigrationBoundaryForState(
  manifest: AirportReleaseMigrationManifest,
  state: AirportMigrationState,
): AirportMigrationBoundary | undefined {
  if (state.boundary === "empty") return undefined;
  const tag = {
    "0014": "0014_fix_flight_share_invalidation",
    "0015": "0015_airport_source_provenance",
    "0016": "0016_serialize_owner_flight_sharing",
    "0017": "0017_public_share_handles",
  }[state.boundary];
  return manifest.permittedBefore.find((boundary) => boundary.tag === tag);
}

export function expectedAirportReleaseMigrationBoundary(
  manifest: AirportReleaseMigrationManifest,
  before: AirportMigrationState,
): AirportMigrationBoundary {
  const current = airportMigrationBoundaryForState(manifest, before);
  if (!current) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
  return current.appliedCount < manifest.expectedAfter.appliedCount
    ? manifest.expectedAfter
    : current;
}

export function airportMigrationStateMatchesBoundary(
  state: AirportMigrationState,
  boundary: AirportMigrationBoundary,
): boolean {
  return (
    state.appliedCount === boundary.appliedCount &&
    state.ledgerSha256 === boundary.ledgerSha256
  );
}

export interface UnsafeSqlClient {
  unsafe(
    query: string,
    parameters?: unknown[],
  ): Promise<Array<Record<string, unknown>>>;
}

const AIRPORT_COLUMNS_0008 = [
  "city",
  "country",
  "created_at",
  "dataset_version",
  "facility",
  "iata",
  "icao",
  "id",
  "latitude",
  "local_code",
  "longitude",
  "name",
  "region",
  "scheduled_service",
  "updated_at",
];

const AIRPORT_COLUMNS_0014 = [
  ...AIRPORT_COLUMNS_0008,
  "search_key",
  "search_keywords",
  "source_ident",
].sort();

const AIRPORT_COLUMNS_0015 = [
  ...AIRPORT_COLUMNS_0014,
  "source_ident_provenance",
].sort();

const ALIAS_COLUMNS = [
  "airport_id",
  "code",
  "code_type",
  "created_at",
  "id",
  "priority",
  "updated_at",
];

function migrationLedgerSha256(
  entries: Array<{ sha256: string; createdAt: number }>,
): string {
  return sha256Bytes(
    JSON.stringify(
      entries.map(({ sha256, createdAt }) => ({
        hash: sha256,
        createdAt,
      })),
    ),
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateAirportMigrationInventory(
  manifest: AirportReleaseMigrationManifest,
  journal: MigrationJournal,
  sqlFiles: string[],
  actualHashes: Record<string, string>,
): void {
  if (
    manifest.schemaVersion !== 1 ||
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    manifest.entries.length === 0 ||
    manifest.entries.length !== journal.entries.length
  ) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
  const expectedFiles = manifest.entries
    .map(({ tag }) => `${tag}.sql`)
    .sort();
  const actualFiles = [...sqlFiles].sort();
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some((file, index) => file !== actualFiles[index])
  ) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch", {
      actualCount: actualFiles.length,
      expectedCount: expectedFiles.length,
    });
  }
  for (const [order, migration] of manifest.entries.entries()) {
    const journalEntry = journal.entries[order];
    if (
      migration.order !== order ||
      !/^\d{4}_[a-z0-9_]+$/.test(migration.tag) ||
      !Number.isSafeInteger(migration.createdAt) ||
      !validSha256(migration.sha256) ||
      journalEntry?.tag !== migration.tag ||
      journalEntry.when !== migration.createdAt ||
      journalEntry.version !== "7" ||
      journalEntry.breakpoints !== true ||
      actualHashes[migration.tag] !== migration.sha256
    ) {
      throw new AirportCatalogSafetyError("migration-ledger-mismatch", {
        referenceIndex: order,
      });
    }
  }
  const allowedBoundaries = new Map(
    manifest.permittedBefore.map((boundary) => [
      boundary.tag,
      boundary,
    ]),
  );
  if (
    allowedBoundaries.size !== 4 ||
    manifest.permittedBefore.length !== 4
  ) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
  for (const requiredTag of [
    "0014_fix_flight_share_invalidation",
    "0015_airport_source_provenance",
    "0016_serialize_owner_flight_sharing",
    "0017_public_share_handles",
  ]) {
    const boundary = allowedBoundaries.get(requiredTag);
    const index = manifest.entries.findIndex(
      ({ tag }) => tag === requiredTag,
    );
    if (
      !boundary ||
      index < 0 ||
      boundary.appliedCount !== index + 1 ||
      boundary.ledgerSha256 !==
        migrationLedgerSha256(manifest.entries.slice(0, index + 1))
    ) {
      throw new AirportCatalogSafetyError("migration-ledger-mismatch");
    }
  }
  const expectedAfter = allowedBoundaries.get(
    "0015_airport_source_provenance",
  );
  if (
    !expectedAfter ||
    canonicalJson(manifest.expectedAfter) !== canonicalJson(expectedAfter)
  ) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
}

export async function loadAirportReleaseMigrationManifest(): Promise<
  LoadedAirportReleaseMigrationManifest
> {
  let manifest: AirportReleaseMigrationManifest;
  let journal: MigrationJournal;
  let releaseScope: AirportReleaseScope;
  try {
    const [configContents, journalContents] = await Promise.all([
      readFile(releaseConfigPath, "utf8"),
      readFile(path.join(migrationsRoot, "meta", "_journal.json"), "utf8"),
    ]);
    const parsed = (
      JSON.parse(configContents) as {
        migrationManifest: AirportReleaseMigrationManifest;
        releaseScope: AirportReleaseScope;
      }
    );
    manifest = parsed.migrationManifest;
    if (
      canonicalJson(parsed.releaseScope) !==
      canonicalJson(AIRPORT_RELEASE_SCOPE)
    ) {
      throw new Error("scope");
    }
    releaseScope = parsed.releaseScope;
    journal = JSON.parse(journalContents) as MigrationJournal;
  } catch {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
  const sqlFiles = (await readdir(migrationsRoot)).filter((file) =>
    file.endsWith(".sql"),
  );
  const actualHashes = Object.fromEntries(
    await Promise.all(
      sqlFiles.map(async (file) => [
        file.slice(0, -4),
        createHash("sha256")
          .update(await readFile(path.join(migrationsRoot, file)))
          .digest("hex"),
      ]),
    ),
  );
  validateAirportMigrationInventory(
    manifest,
    journal,
    sqlFiles,
    actualHashes,
  );
  return {
    ...manifest,
    sha256: sha256Bytes(canonicalJson(manifest)),
    releaseScope,
  };
}

export async function loadAirportReleaseMigrations(): Promise<
  AirportReleaseMigration[]
> {
  return (await loadAirportReleaseMigrationManifest()).entries;
}

export async function applyPendingAirportMigrations(
  sql: UnsafeSqlClient,
): Promise<void> {
  const manifest = await loadAirportReleaseMigrationManifest();
  const [countRow] = await sql.unsafe(
    `select count(*)::integer as count
     from drizzle.__drizzle_migrations`,
  );
  const appliedCount = Number(countRow?.count);
  const currentBoundary = manifest.permittedBefore.find(
    (boundary) => boundary.appliedCount === appliedCount,
  );
  if (!currentBoundary) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch");
  }
  if (appliedCount >= manifest.expectedAfter.appliedCount) return;
  for (const migration of manifest.entries.slice(
    appliedCount,
    manifest.expectedAfter.appliedCount,
  )) {
    const contents = await readFile(
      path.join(migrationsRoot, `${migration.tag}.sql`),
      "utf8",
    );
    for (const statement of contents.split("--> statement-breakpoint")) {
      if (statement.trim()) await sql.unsafe(statement);
    }
    await sql.unsafe(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       values ($1, $2)`,
      [migration.sha256, migration.createdAt],
    );
  }
}

function stringArray(
  rows: Array<Record<string, unknown>>,
  field: string,
): string[] {
  return rows.map((row) => String(row[field])).sort();
}

function assertEqualList(actual: string[], expected: string[]) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new AirportCatalogSafetyError("schema-state-mismatch", {
      actualCount: actual.length,
      expectedCount: expected.length,
    });
  }
}

async function tableColumns(
  sql: UnsafeSqlClient,
  tableName: string,
): Promise<string[]> {
  return stringArray(
    await sql.unsafe(
      `select column_name
       from information_schema.columns
       where table_schema = 'public' and table_name = $1
       order by column_name`,
      [tableName],
    ),
    "column_name",
  );
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

async function verifyProductMigrationState(sql: UnsafeSqlClient) {
  const [defaults] = await sql.unsafe(
    `select
       max(column_default) filter (where column_name = 'distance_unit')
         as distance_default,
       max(column_default) filter (where column_name = 'map_view_mode')
         as map_default
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_profiles'
       and column_name = any($1::text[])`,
    [["distance_unit", "map_view_mode"]],
  );
  if (
    !String(defaults?.distance_default).includes("nautical_miles") ||
    !String(defaults?.map_default).includes("globe")
  ) {
    throw new AirportCatalogSafetyError("schema-state-mismatch");
  }
  const requiredObjects = [
    "airport_aliases_airport_code_type_unique",
    "airport_aliases_code_priority_idx",
    "airport_aliases_pkey",
    "airports_iata_unique",
    "airports_icao_unique",
    "airports_local_code_idx",
    "airports_pkey",
    "airports_search_key_idx",
    "airports_source_ident_unique",
    "flight_stops_flight_order_pk",
    "flight_stops_user_flight_idx",
  ];
  const objectRows = await sql.unsafe(
    `select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = any($1::text[])
     order by c.relname`,
    [requiredObjects],
  );
  assertEqualList(stringArray(objectRows, "relname"), requiredObjects);
  const triggerRows = await sql.unsafe(
    `select tgname
     from pg_trigger
     where not tgisinternal
       and tgname = any($1::text[])
     order by tgname`,
    [[
      "flights_invalidate_selected_share",
      "flight_stops_invalidate_selected_share",
    ]],
  );
  assertEqualList(
    stringArray(triggerRows, "tgname"),
    [
      "flight_stops_invalidate_selected_share",
      "flights_invalidate_selected_share",
    ],
  );
}

async function verifyAirportSchema(
  sql: UnsafeSqlClient,
  boundary: AirportMigrationState["boundary"],
): Promise<string> {
  if (boundary === "empty") {
    if (await relationExists(sql, "public.airports")) {
      throw new AirportCatalogSafetyError("schema-state-mismatch");
    }
    return createHash("sha256").update("empty").digest("hex");
  }
  const expectedAirportColumns =
    boundary === "0014" ? AIRPORT_COLUMNS_0014 : AIRPORT_COLUMNS_0015;
  const airportColumns = await tableColumns(sql, "airports");
  assertEqualList(airportColumns, expectedAirportColumns);
  const aliasesPresent = await relationExists(
    sql,
    "public.airport_aliases",
  );
  const stopsPresent = await relationExists(sql, "public.flight_stops");
  if (!aliasesPresent || !stopsPresent) {
    throw new AirportCatalogSafetyError("schema-state-mismatch");
  }
  assertEqualList(
    await tableColumns(sql, "airport_aliases"),
    ALIAS_COLUMNS,
  );
  await verifyProductMigrationState(sql);
  let provenanceConstraint = "";
  if (
    boundary === "0015" ||
    boundary === "0016" ||
    boundary === "0017"
  ) {
    const [constraint] = await sql.unsafe(
      `select pg_get_constraintdef(oid, true) as definition
       from pg_constraint
       where conname = 'airports_source_ident_provenance_valid'`,
    );
    if (!constraint) {
      throw new AirportCatalogSafetyError("schema-state-mismatch");
    }
    provenanceConstraint = String(constraint.definition);
  }
  return createHash("sha256")
    .update(JSON.stringify({
      boundary,
      airportColumns,
      aliasColumns: await tableColumns(sql, "airport_aliases"),
      provenanceConstraint,
      stopsPresent,
    }))
    .digest("hex");
}

export async function verifyAirportMigrationState(
  sql: UnsafeSqlClient,
  environment: "production" | "test",
): Promise<AirportMigrationState> {
  const manifest = await loadAirportReleaseMigrationManifest();
  const ledgerExists = await relationExists(
    sql,
    "drizzle.__drizzle_migrations",
  );
  const rows = ledgerExists
    ? await sql.unsafe(
        `select id, hash, created_at
         from drizzle.__drizzle_migrations
         order by created_at, id`,
      )
    : [];
  const boundary = validateAirportMigrationLedger(
    rows as unknown as AirportMigrationLedgerRow[],
    manifest,
    environment,
  );
  const ledgerSha256 = sha256Bytes(
    JSON.stringify(
      rows.map((row) => ({
        hash: row.hash,
        createdAt: Number(row.created_at),
      })),
    ),
  );
  return {
    boundary,
    appliedCount: rows.length,
    ledgerSha256,
    schemaSha256: await verifyAirportSchema(sql, boundary),
    migrationManifestSha256: manifest.sha256,
  };
}

export function validateAirportMigrationLedger(
  rows: AirportMigrationLedgerRow[],
  manifest: AirportReleaseMigrationManifest,
  environment: "production" | "test",
): AirportMigrationState["boundary"] {
  if (rows.length === 0 && environment === "test") return "empty";
  if (rows.length > manifest.entries.length) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch", {
      actualCount: rows.length,
      expectedCount: manifest.entries.length,
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const expected = manifest.entries[index];
    const actual = rows[index];
    if (
      actual.hash !== expected.sha256 ||
      Number(actual.created_at) !== expected.createdAt
    ) {
      throw new AirportCatalogSafetyError("migration-ledger-mismatch", {
        referenceIndex: index,
      });
    }
  }
  const ledgerSha256 = sha256Bytes(
    JSON.stringify(
      rows.map((row) => ({
        hash: row.hash,
        createdAt: Number(row.created_at),
      })),
    ),
  );
  const matched = manifest.permittedBefore.find(
    (boundary) =>
      boundary.appliedCount === rows.length &&
      boundary.ledgerSha256 === ledgerSha256,
  );
  const boundary =
    matched?.tag === "0014_fix_flight_share_invalidation"
      ? "0014"
      : matched?.tag === "0015_airport_source_provenance"
        ? "0015"
        : matched?.tag === "0016_serialize_owner_flight_sharing"
          ? "0016"
          : matched?.tag === "0017_public_share_handles"
            ? "0017"
          : undefined;
  if (!boundary) {
    throw new AirportCatalogSafetyError("migration-ledger-mismatch", {
      actualCount: rows.length,
    });
  }
  return boundary;
}
