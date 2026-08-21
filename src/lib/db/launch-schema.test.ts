import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accountDeletionRequests,
  accountDeletionTokens,
  backgroundJobs,
  deletionTombstones,
  flightStops,
  importBatches,
  importBatchStatus,
  mapShareFlights,
  mapShares,
  sessions,
  userProfiles,
} from "./schema";
import {
  assertRuntimeReadOnlySetting,
  databasePoolMax,
  RUNTIME_READ_ONLY_POSTGRES_OPTIONS,
  runtimeDatabaseClientOptions,
  runtimeDatabaseConnectionParameters,
  runtimeDatabaseUrl,
} from "./index";
import {
  createWorkerDatabases,
  workerDatabaseClientOptions,
} from "./worker";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0002_launch_schema.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const sharingMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0008_read_only_map_sharing.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const sharingTriggerFixMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0014_fix_flight_share_invalidation.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const sharingSerializationMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0016_serialize_owner_flight_sharing.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const multiStopMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0012_multi_stop_flight_routes.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("database pool sizing", () => {
  it("defaults production/Vercel processes to one connection", () => {
    expect(databasePoolMax({ NODE_ENV: "production" })).toBe(1);
  });

  it("allows a worker role to opt into a bounded larger pool", () => {
    expect(
      databasePoolMax({ NODE_ENV: "production", DB_POOL_MAX: "5" }),
    ).toBe(5);
    expect(() =>
      databasePoolMax({ NODE_ENV: "production", DB_POOL_MAX: "0" }),
    ).toThrow(/1 to 20/);
    expect(() =>
      databasePoolMax({ NODE_ENV: "production", DB_POOL_MAX: "many" }),
    ).toThrow(/1 to 20/);
  });

  it("makes every runtime connection read-only during a release pause", () => {
    const paused = {
      NODE_ENV: "production",
      FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
    };
    expect(
      runtimeDatabaseConnectionParameters(paused),
    ).toEqual({
      options: RUNTIME_READ_ONLY_POSTGRES_OPTIONS,
    });
    expect(runtimeDatabaseClientOptions(paused).connection).toEqual({
      options: RUNTIME_READ_ONLY_POSTGRES_OPTIONS,
    });
    expect(workerDatabaseClientOptions(paused).connection).toEqual({
      options: RUNTIME_READ_ONLY_POSTGRES_OPTIONS,
    });
    expect(runtimeDatabaseConnectionParameters({ NODE_ENV: "test" })).toEqual(
      {},
    );
    expect(runtimeDatabaseClientOptions({ NODE_ENV: "test" }).connection).toEqual(
      {},
    );
    expect(workerDatabaseClientOptions({ NODE_ENV: "test" }).connection).toEqual(
      {},
    );
  });

  it("bypasses Neon transaction pooling only for paused runtime connections", () => {
    const pooled =
      "postgres://ep-example-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
    expect(
      runtimeDatabaseUrl(pooled, {
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    ).toBe(
      "postgres://ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(runtimeDatabaseUrl(pooled, {})).toBe(pooled);
    const local = "postgres://localhost:5432/neondb";
    expect(
      runtimeDatabaseUrl(local, {
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    ).toBe(local);
  });

  it("fails workers and health closed while preserving normal mode", () => {
    expect(() =>
      createWorkerDatabases({
        DATABASE_URL: "postgres://example.invalid/flight_map",
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    ).toThrow(/temporarily read-only/);
    expect(() =>
      assertRuntimeReadOnlySetting(
        [{ default_transaction_read_only: "on" }],
        { FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true" },
      ),
    ).not.toThrow();
    expect(() =>
      assertRuntimeReadOnlySetting(
        [{ default_transaction_read_only: "off" }],
        { FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true" },
      ),
    ).toThrow(/temporarily read-only/);
    expect(() =>
      assertRuntimeReadOnlySetting(
        [{ default_transaction_read_only: "on" }],
        {},
      ),
    ).toThrow(/temporarily read-only/);
  });
});

describe("launch schema", () => {
  it("models import lifecycle states and bounded lifecycle metadata", () => {
    expect(importBatchStatus.enumValues).toEqual(
      expect.arrayContaining([
        "queued",
        "scanning",
        "retrying",
        "committing",
        "cancelled",
        "quarantined",
      ]),
    );
    const config = getTableConfig(importBatches);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "idempotency_key",
        "upload_completed_at",
        "scan_status",
        "scan_attempts",
        "retry_count",
        "next_retry_at",
        "cancel_requested_at",
        "original_deleted_at",
        "snapshots_scrubbed_at",
        "purge_after",
        "purged_at",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "import_batches_user_idempotency_unique",
        "import_batches_retry_ready_idx",
        "import_batches_retention_due_idx",
        "import_batches_purge_due_idx",
      ]),
    );
  });

  it("keeps the global queue explicit, owner-attributed, and claimable", () => {
    const config = getTableConfig(backgroundJobs);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "user_id",
        "state",
        "idempotency_key",
        "available_at",
        "lease_owner",
        "lease_expires_at",
        "attempts",
        "max_attempts",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "background_jobs_user_type_idempotency_unique",
        "background_jobs_ready_idx",
        "background_jobs_lease_expiry_idx",
      ]),
    );
    expect(migration).toContain(
      "Internal global queue. Intentionally has no user RLS",
    );
    expect(migration).not.toContain(
      'CREATE POLICY "background_jobs_owner_policy"',
    );
  });

  it("keeps profiles and deletion requests owner-private", () => {
    expect(getTableConfig(userProfiles).name).toBe("user_profiles");
    expect(getTableConfig(accountDeletionRequests).name).toBe(
      "account_deletion_requests",
    );
    expect(migration).toContain(
      'CREATE POLICY "user_profiles_owner_policy"',
    );
    expect(migration).toContain(
      'CREATE POLICY "account_deletion_requests_owner_policy"',
    );
  });

  it("records recent authentication without changing opaque session tokens", () => {
    expect(
      getTableConfig(sessions).columns.map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "session_token",
        "user_id",
        "expires",
        "authenticated_at",
      ]),
    );
  });

  it("stores only hashed deletion controls and minimal tombstones", () => {
    const tokenColumns = getTableConfig(accountDeletionTokens).columns.map(
      (column) => column.name,
    );
    expect(tokenColumns).toContain("token_hash");
    expect(tokenColumns).not.toEqual(
      expect.arrayContaining(["token", "email", "username"]),
    );
    expect(
      getTableConfig(deletionTombstones).columns.map((column) => column.name),
    ).toEqual([
      "subject_hash",
      "deleted_at",
      "purge_verified_at",
      "retain_until",
    ]);
  });

  it("models one hashed, owner-private, revocable map share", () => {
    const config = getTableConfig(mapShares);
    expect(config.columns.map((column) => column.name)).toEqual([
      "user_id",
      "public_id",
      "token_hash",
      "token_version",
      "include_display_name",
      "scope_type",
      "projection",
      "enabled_at",
      "disabled_at",
      "rotated_at",
      "created_at",
      "updated_at",
    ]);
    expect(sharingMigration).toContain(
      'CREATE POLICY "map_shares_owner_policy"',
    );
    expect(sharingMigration).toContain("SECURITY DEFINER");
    expect(getTableConfig(mapShareFlights).columns.map(({ name }) => name)).toEqual([
      "user_id",
      "flight_id",
      "selected_at",
    ]);
    expect(sharingMigration).toContain("FROM public.map_share_flights selected");
    expect(sharingMigration).toContain(
      'CREATE TRIGGER "flights_invalidate_selected_share"',
    );
    expect(sharingMigration).toContain(
      "REVOKE ALL ON FUNCTION public_map_projection(uuid, text) FROM PUBLIC",
    );
    expect(sharingMigration).toContain(
      "SET search_path = pg_catalog, public",
    );
    expect(sharingMigration).not.toContain("GRANT EXECUTE");
    expect(sharingMigration).not.toMatch(
      /email|registration|notes|flight_number|source_type/i,
    );
    expect(sharingTriggerFixMigration).toContain("IF TG_OP = 'DELETE'");
    expect(sharingTriggerFixMigration).toContain("RETURN OLD");
    expect(sharingTriggerFixMigration).toContain("RETURN NEW");
    expect(sharingTriggerFixMigration).toContain(
      "REVOKE ALL ON FUNCTION invalidate_selected_map_share() FROM PUBLIC",
    );
    expect(sharingSerializationMigration).toContain(
      "pg_advisory_xact_lock(hashtextextended(affected_user_id::text, 0))",
    );
    expect(sharingSerializationMigration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "flights"',
    );
    expect(sharingSerializationMigration).toContain(
      "CREATE OR REPLACE FUNCTION invalidate_selected_map_share_for_stop()",
    );
  });

  it("backfills ordered tenant-scoped stops without replacing flight IDs", () => {
    expect(getTableConfig(flightStops).columns.map(({ name }) => name)).toEqual([
      "user_id",
      "flight_id",
      "stop_order",
      "airport_id",
      "created_at",
      "updated_at",
    ]);
    expect(multiStopMigration).toContain(
      'CREATE TABLE IF NOT EXISTS "flight_stops"',
    );
    expect(multiStopMigration).toContain(
      'CREATE POLICY "flight_stops_owner_policy"',
    );
    expect(multiStopMigration).toContain(
      'SELECT "user_id", "id", 0, "origin_airport_id"',
    );
    expect(multiStopMigration).toContain(
      'SELECT "user_id", "id", 1, "destination_airport_id"',
    );
    expect(multiStopMigration).toContain(
      'ON CONFLICT ("flight_id", "stop_order") DO NOTHING',
    );
    expect(multiStopMigration).not.toMatch(/UPDATE\s+"flights"\s+SET\s+"id"/i);
  });

  it("is additive over both clean and existing foundation databases", () => {
    expect(migration).toContain(
      'ALTER TYPE "public"."import_batch_status" RENAME TO "import_batch_status_legacy"',
    );
    expect(migration).toContain(
      `"idempotency_key" = 'legacy-batch:' || "id"::text`,
    );
    expect(migration).not.toMatch(
      /DROP TABLE|TRUNCATE|DELETE FROM "users"|DELETE FROM "import_batches"/,
    );
  });
});

describe("migration database URL", () => {
  it("prefers the migration role without removing runtime fallback", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../drizzle.config.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(
      /MIGRATION_DATABASE_URL[\s\S]+DATABASE_URL/,
    );
  });
});
