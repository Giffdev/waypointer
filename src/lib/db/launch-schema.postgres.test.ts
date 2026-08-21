import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { runtimeDatabaseConnectionParameters } from "./index";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS === "true" &&
  Boolean(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const createdDatabases: string[] = [];

postgresDescribe("launch migration clean and upgrade paths", () => {
  afterAll(async () => {
    const admin = postgres(adminUrl(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      for (const database of createdDatabases.splice(0)) {
        await admin.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`,
        );
        await admin.unsafe(`drop database if exists "${database}"`);
      }
    } finally {
      await admin.end();
    }
  });

  it("applies all migrations to a clean database", async () => {
    const database = await createDatabase("clean");
    const client = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await applyMigration(client, "0000_multi_user_import_foundation.sql");
      await applyMigration(client, "0001_privacy_retention_hardening.sql");
      await applyMigration(client, "0002_launch_schema.sql");
      await applyMigration(client, "0003_import_review.sql");
      await applyMigration(client, "0003_recent_authentication.sql");
      await applyMigration(client, "0004_durable_import.sql");
      await applyMigration(client, "0005_editable_usernames.sql");
      await applyMigration(client, "0006_synchronous_import_completion.sql");
      await applyMigration(client, "0007_flight_role_provenance.sql");
      await applyMigration(client, "0008_read_only_map_sharing.sql");
      await applyMigration(client, "0009_airport_identifier_aliases.sql");
      await applyMigration(client, "0010_airport_name_search.sql");
      await applyMigration(client, "0011_nautical_miles_profile_default.sql");
      await applyMigration(client, "0012_multi_stop_flight_routes.sql");
      await applyMigration(client, "0013_map_view_mode_preference.sql");
      await applyMigration(client, "0014_fix_flight_share_invalidation.sql");
      await applyMigration(client, "0015_airport_source_provenance.sql");
      await applyMigration(client, "0016_serialize_owner_flight_sharing.sql");
      await applyMigration(client, "0017_public_share_handles.sql");
      const tables = await client<{ table_name: string }[]>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'user_profiles',
            'background_jobs',
            'account_deletion_requests',
            'account_deletion_tokens',
            'deletion_tombstones'
            ,'map_shares',
            'map_share_flights',
            'flight_stops'
          )
      `;
      expect(tables.map((row) => row.table_name).sort()).toEqual([
        "account_deletion_requests",
        "account_deletion_tokens",
        "background_jobs",
        "deletion_tombstones",
        "flight_stops",
        "map_share_flights",
        "map_shares",
        "user_profiles",
      ]);
      await client`
        insert into users (email, username)
        values ('pilot-one@example.test', 'flight_pilot')
      `;
      await expect(
        client`
          insert into users (email, username)
          values ('pilot-two@example.test', 'flight_pilot')
        `,
      ).rejects.toMatchObject({
        code: "23505",
        constraint_name: "users_username_unique",
      });
      await expect(
        client`
          insert into users (email, username)
          values ('pilot-three@example.test', 'not valid')
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "users_username_format",
      });
    } finally {
      await client.end();
    }
  });

  it("upgrades existing batches without losing lifecycle identity", async () => {
    const database = await createDatabase("upgrade");
    const client = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const userId = randomUUID();
    const batchId = randomUUID();
    try {
      await applyMigration(client, "0000_multi_user_import_foundation.sql");
      await applyMigration(client, "0001_privacy_retention_hardening.sql");
      await client`
        insert into users (id, email, username)
        values (${userId}, ${`${userId}@example.test`}, ${`launch-${userId}`})
      `;
      await client.begin(async (tx) => {
        await tx`select set_config('app.current_user_id', ${userId}, true)`;
        await tx`
          insert into import_batches (
            id, user_id, adapter_id, adapter_version, status,
            original_object_key, original_file_name, file_sha256,
            file_size_bytes, expires_at
          ) values (
            ${batchId}, ${userId}, 'foreflight-v1', 1, 'review',
            'imports/test.csv', 'test.csv', ${"a".repeat(64)},
            42, now() + interval '7 days'
          )
        `;
      });
      await applyMigration(client, "0002_launch_schema.sql");
      await applyMigration(client, "0003_import_review.sql");
      await applyMigration(client, "0003_recent_authentication.sql");
      await applyMigration(client, "0004_durable_import.sql");
      await applyMigration(client, "0005_editable_usernames.sql");
      await applyMigration(client, "0006_synchronous_import_completion.sql");
      await applyMigration(client, "0007_flight_role_provenance.sql");
      await applyMigration(client, "0008_read_only_map_sharing.sql");
      await applyMigration(client, "0009_airport_identifier_aliases.sql");
      await applyMigration(client, "0010_airport_name_search.sql");
      await applyMigration(client, "0011_nautical_miles_profile_default.sql");
      await applyMigration(client, "0012_multi_stop_flight_routes.sql");
      await applyMigration(client, "0013_map_view_mode_preference.sql");
      await applyMigration(client, "0014_fix_flight_share_invalidation.sql");
      await applyMigration(client, "0015_airport_source_provenance.sql");
      await applyMigration(client, "0016_serialize_owner_flight_sharing.sql");
      const existingPublicId = randomUUID();
      await client`
        update users
        set password_hash = 'existing-password-hash'
        where id = ${userId}
      `;
      await client`
        insert into map_shares (
          user_id,
          public_id,
          token_hash,
          token_version,
          include_display_name,
          scope_type,
          projection,
          enabled_at
        ) values (
          ${userId},
          ${existingPublicId},
          ${"a".repeat(64)},
          1,
          false,
          'selected_flights',
          '{"owner":{"displayName":null},"summary":{"flightCount":0,"routeCount":0},"routes":[]}'::jsonb,
          now()
        )
      `;
      await applyMigration(client, "0017_public_share_handles.sql");
      const [batch] = await client<{
        status: string;
        scan_status: string;
        idempotency_key: string;
        imported_rows: number;
      }[]>`
        select status::text, scan_status::text, idempotency_key, imported_rows
        from import_batches
        where id = ${batchId}
      `;
      expect(batch).toEqual({
        status: "review",
        scan_status: "legacy_unscanned",
        idempotency_key: `legacy-batch:${batchId}`,
        imported_rows: 0,
      });
      const [owner] = await client<{
        username: string;
      }[]>`
        select username
        from users
        where id = ${userId}
      `;
      expect(owner.username).toMatch(/^[a-z0-9][a-z0-9_-]{2,29}$/);
      expect(
        owner.username.endsWith(`_${userId.replaceAll("-", "").slice(0, 8)}`),
      ).toBe(true);
      const [share] = await client<{
        disabled_at: Date | null;
      }[]>`
        select disabled_at
        from map_shares
        where user_id = ${userId}
      `;
      expect(share.disabled_at).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });

  it("remediates reserved and collision-prone usernames from 0016 before validating 0017", async () => {
    const database = await createDatabase("reserved_handles");
    const client = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const adminId = "11111111-1111-4111-8111-111111111111";
    const settingsId = "33333333-3333-4333-8333-333333333333";
    const supportId = "44444444-4444-4444-8444-444444444444";
    const collisionOwnerId = "22222222-2222-4222-8222-222222222222";
    const occupiedAdminCandidate = `private_${adminId
      .replaceAll("-", "")
      .slice(0, 22)}`;
    const remediatedAdminCandidate = `private_${createHash("sha256")
      .update(`${adminId}:1`)
      .digest("hex")
      .slice(0, 22)}`;
    try {
      for (const migration of [
        "0000_multi_user_import_foundation.sql",
        "0001_privacy_retention_hardening.sql",
        "0002_launch_schema.sql",
        "0003_import_review.sql",
        "0003_recent_authentication.sql",
        "0004_durable_import.sql",
        "0005_editable_usernames.sql",
        "0006_synchronous_import_completion.sql",
        "0007_flight_role_provenance.sql",
        "0008_read_only_map_sharing.sql",
        "0009_airport_identifier_aliases.sql",
        "0010_airport_name_search.sql",
        "0011_nautical_miles_profile_default.sql",
        "0012_multi_stop_flight_routes.sql",
        "0013_map_view_mode_preference.sql",
        "0014_fix_flight_share_invalidation.sql",
        "0015_airport_source_provenance.sql",
        "0016_serialize_owner_flight_sharing.sql",
      ]) {
        await applyMigration(client, migration);
      }
      await client`
        insert into users (id, email, username)
        values
          (${adminId}, 'legacy-admin@example.test', 'admin'),
          (${settingsId}, 'legacy-settings@example.test', 'settings'),
          (${supportId}, 'legacy-support@example.test', 'support'),
          (
            ${collisionOwnerId},
            'candidate-owner@example.test',
            ${occupiedAdminCandidate}
          )
      `;
      await client`
        insert into map_shares (
          user_id,
          public_id,
          token_hash,
          token_version,
          include_display_name,
          scope_type,
          projection,
          enabled_at
        ) values (
          ${adminId},
          ${randomUUID()},
          ${"a".repeat(64)},
          7,
          false,
          'selected_flights',
          '{"owner":{"displayName":null},"summary":{"flightCount":0,"routeCount":0},"routes":[]}'::jsonb,
          now()
        )
      `;

      await applyMigration(client, "0017_public_share_handles.sql");

      const remediated = await client<{
        id: string;
        username: string;
      }[]>`
        select id, username
        from users
        where id in (
          ${adminId},
          ${settingsId},
          ${supportId},
          ${collisionOwnerId}
        )
        order by id
      `;
      expect(remediated).toEqual([
        {
          id: adminId,
          username: remediatedAdminCandidate,
        },
        {
          id: collisionOwnerId,
          username: occupiedAdminCandidate,
        },
        {
          id: settingsId,
          username: `private_${settingsId.replaceAll("-", "").slice(0, 22)}`,
        },
        {
          id: supportId,
          username: `private_${supportId.replaceAll("-", "").slice(0, 22)}`,
        },
      ]);
      expect(new Set(remediated.map(({ username }) => username)).size).toBe(
        remediated.length,
      );
      const [reservedConstraint] = await client<{ convalidated: boolean }[]>`
        select convalidated
        from pg_constraint
        where conname = 'users_public_handle_not_reserved'
      `;
      expect(reservedConstraint.convalidated).toBe(true);
      const [share] = await client<{
        disabled_at: Date | null;
      }[]>`
        select disabled_at
        from map_shares
        where user_id = ${adminId}
      `;
      expect(share.disabled_at).toBeInstanceOf(Date);
      await expect(
        client`
          insert into users (email, username)
          values ('new-reserved@example.test', 'support')
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "users_public_handle_not_reserved",
      });
    } finally {
      await client.end();
    }
  });

  it("normalizes legacy usernames safely while preserving case-insensitive uniqueness", async () => {
    const database = await createDatabase("usernames");
    const client = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const mixedCaseId = randomUUID();
    const invalidId = randomUUID();
    try {
      await applyMigration(client, "0000_multi_user_import_foundation.sql");
      await client`
        insert into users (id, email, username)
        values
          (${mixedCaseId}, ${`${mixedCaseId}@example.test`}, 'Mixed_Pilot'),
          (${invalidId}, ${`${invalidId}@example.test`}, '!!!')
      `;
      await expect(
        client`
          insert into users (email, username)
          values ('case-conflict@example.test', 'mixed_pilot')
        `,
      ).rejects.toMatchObject({
        code: "23505",
        constraint_name: "users_username_unique",
      });

      await applyMigration(client, "0001_privacy_retention_hardening.sql");
      await applyMigration(client, "0002_launch_schema.sql");
      await applyMigration(client, "0003_import_review.sql");
      await applyMigration(client, "0003_recent_authentication.sql");
      await applyMigration(client, "0004_durable_import.sql");
      await applyMigration(client, "0005_editable_usernames.sql");

      const normalized = await client<{ id: string; username: string }[]>`
        select id, username
        from users
        where id in (${mixedCaseId}, ${invalidId})
        order by id
      `;
      expect(normalized).toEqual(
        expect.arrayContaining([
          { id: mixedCaseId, username: "mixed_pilot" },
          {
            id: invalidId,
            username: `pilot_${invalidId.replaceAll("-", "").slice(0, 8)}`,
          },
        ]),
      );
      expect(
        normalized.every(({ username }) =>
          /^[a-z0-9][a-z0-9_-]{2,29}$/.test(username),
        ),
      ).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("backfills globally unique airport source identifiers across code namespaces", async () => {
    const database = await createDatabase("airport_identifiers");
    const client = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await applyMigration(client, "0000_multi_user_import_foundation.sql");
      await client`
        insert into airports (
          icao, iata, local_code, name, country, latitude, longitude,
          facility, dataset_version
        ) values
          ('KAAA', 'AAA', 'AAA', 'ICAO owner', 'US', 1, 1, 'airport', 'test'),
          (null, 'BBB', 'KAAA', 'Local collision', 'US', 2, 2, 'airport', 'test'),
          (null, 'KAAA', null, 'IATA collision', 'US', 3, 3, 'airport', 'test')
      `;

      for (const migration of [
        "0001_privacy_retention_hardening.sql",
        "0002_launch_schema.sql",
        "0003_import_review.sql",
        "0003_recent_authentication.sql",
        "0004_durable_import.sql",
        "0005_editable_usernames.sql",
        "0006_synchronous_import_completion.sql",
        "0007_flight_role_provenance.sql",
        "0008_read_only_map_sharing.sql",
        "0009_airport_identifier_aliases.sql",
        "0010_airport_name_search.sql",
        "0011_nautical_miles_profile_default.sql",
        "0012_multi_stop_flight_routes.sql",
        "0013_map_view_mode_preference.sql",
        "0014_fix_flight_share_invalidation.sql",
        "0015_airport_source_provenance.sql",
        "0016_serialize_owner_flight_sharing.sql",
        "0017_public_share_handles.sql",
      ]) {
        await applyMigration(client, migration);
      }

      const identifiers = await client<{
        name: string;
        source_ident: string | null;
        source_ident_provenance: string | null;
      }[]>`
        select name, source_ident, source_ident_provenance
        from airports
        order by name
      `;
      expect(identifiers).toEqual([
        {
          name: "IATA collision",
          source_ident: null,
          source_ident_provenance: null,
        },
        {
          name: "ICAO owner",
          source_ident: "KAAA",
          source_ident_provenance: "legacy-code-backfill",
        },
        {
          name: "Local collision",
          source_ident: "BBB",
          source_ident_provenance: "legacy-code-backfill",
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it("starts paused runtime connections read-only and preserves normal writes", async () => {
    const database = await createDatabase("runtime_read_only");
    const normal = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await normal`create table runtime_write_probe (id integer primary key)`;
      await normal`insert into runtime_write_probe (id) values (1)`;
    } finally {
      await normal.end();
    }

    const paused = postgres(databaseUrl(database), {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: runtimeDatabaseConnectionParameters({
        FLIGHT_MAP_RELEASE_WRITES_PAUSED: "true",
      }),
    });
    try {
      const [setting] = await paused<{
        default_transaction_read_only: string;
      }[]>`show default_transaction_read_only`;
      expect(setting.default_transaction_read_only).toBe("on");
      await expect(
        paused`insert into runtime_write_probe (id) values (2)`,
      ).rejects.toMatchObject({ code: "25006" });
      const rows = await paused<{ id: number }[]>`
        select id from runtime_write_probe order by id
      `;
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await paused.end();
    }
  });
});

async function createDatabase(label: string): Promise<string> {
  const database = `flight_map_${label}_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl(), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await admin.unsafe(`create database "${database}"`);
    createdDatabases.push(database);
    return database;
  } finally {
    await admin.end();
  }
}

async function applyMigration(
  client: ReturnType<typeof postgres>,
  fileName: string,
): Promise<void> {
  const contents = readFileSync(
    fileURLToPath(
      new URL(`../../../drizzle/migrations/${fileName}`, import.meta.url),
    ),
    "utf8",
  );
  for (const statement of contents.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

function configuredUrl(): URL {
  const value =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  return new URL(value);
}

function adminUrl(): string {
  const url = configuredUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(database: string): string {
  const url = configuredUrl();
  url.pathname = `/${database}`;
  return url.toString();
}
