import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { flights, flightStops, importBatches, importRows } from "./schema";

/** The token drizzle's migrator splits every migration file on. */
const STATEMENT_BREAKPOINT = ["--", "> statement-breakpoint"].join("");

const migrationsDirectory = fileURLToPath(
  new URL("../../../drizzle/migrations", import.meta.url),
);

/**
 * Migration 0018 safety.
 *
 * The whole point of this migration is that it changes nothing about data that
 * already exists. Every assertion below is really one assertion: a pilot who
 * runs this deploy sees exactly the same map, the same statistics, and the
 * same shares the second before and the second after.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0018_import_identity_and_route_waypoints.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The migration with comment lines removed, for assertions about SQL. */
const migrationSql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("migration 0018", () => {
  it("never rewrites a stop, deletes a row, or drops a column", () => {
    // The real risk this guards is semantic, not syntactic: a backfill that
    // got stop semantics wrong would convert real landings into waypoints or
    // the reverse, and every statistic and share would move. Column defaults
    // do that job without touching a row, so `flight_stops` must never be
    // updated here.
    expect(migrationSql).not.toMatch(/\bUPDATE\s+"?flight_stops\b/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("backfills fingerprint_version truthfully instead of asserting a default", () => {
    // The one deliberate write. `fingerprint_version` exists to say which
    // algorithm produced the digest next to it; the pre-v3 function used
    // version 2 for any flight with more than two committed stops. Leaving
    // every historical row at the `1` default would make that column state
    // something false about every multi-stop flight, in the exact column the
    // adoption chain reads. The stop count is the same discriminator the old
    // function used, so this is a restoration, not an estimate.
    expect(migration).toMatch(
      /UPDATE "flights" f\s+SET "fingerprint_version" = 2/,
    );
    expect(migration).toMatch(
      /SELECT count\(\*\) FROM "flight_stops" s WHERE s\."flight_id" = f\."id"\s*\)\s*> 2/,
    );
    // It touches only that column — never a stop's meaning — and it excludes
    // rows it has already written, so a replay is a no-op.
    const updates = migrationSql.match(/\bUPDATE\b[\s\S]*?;/gi) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toMatch(/stop_kind|source_field/);
    expect(updates[0]).toMatch(/WHERE f\."fingerprint_version" <> 2/);
  });

  it("adds constraints NOT VALID, then validates them in a separate statement", () => {
    // `ADD CONSTRAINT ... CHECK` without `NOT VALID` scans the whole table
    // while holding ACCESS EXCLUSIVE, blocking every read and write for the
    // duration. Splitting the work is what keeps the migration both cheap and
    // honest: the ADD takes ACCESS EXCLUSIVE for an instant, and the VALIDATE
    // takes only SHARE UPDATE EXCLUSIVE while it scans. What must not happen
    // is what happened before — adding NOT VALID and promising a later
    // out-of-transaction validation that nothing schedules, leaving the
    // database permanently holding constraints it does not enforce for
    // pre-existing rows.
    for (const constraint of [
      "flight_stops_stop_kind_valid",
      "flight_stops_source_field_valid",
    ]) {
      expect(migration).toMatch(
        new RegExp(`ADD CONSTRAINT "${constraint}"[\\s\\S]*?NOT VALID`),
      );
      expect(migrationSql).toMatch(
        new RegExp(
          `ADD CONSTRAINT "${constraint}"[\\s\\S]*?NOT VALID;[\\s\\S]*?VALIDATE CONSTRAINT "${constraint}"`,
        ),
      );
    }
    expect(migration).toMatch(
      /import_batches_reprocessed_from_batch_id_fk[\s\S]*?NOT VALID/,
    );
    expect(migrationSql).toMatch(
      /VALIDATE CONSTRAINT "import_batches_reprocessed_from_batch_id_fk"/,
    );
  });

  it("validates every constraint it adds NOT VALID", () => {
    // Guards the general rule rather than the three names above: a fourth
    // NOT VALID constraint added later without a matching VALIDATE would slip
    // past the assertions above and reintroduce the unenforced-constraint
    // promise.
    const notValidated = [
      ...migrationSql.matchAll(/ADD CONSTRAINT "([^"]+)"[\s\S]*?NOT VALID/g),
    ]
      .map(([, name]) => name)
      .filter(
        (name) => !migrationSql.includes(`VALIDATE CONSTRAINT "${name}"`),
      );
    expect(notValidated).toEqual([]);
  });

  it("never uses CONCURRENTLY, which the transactional runner cannot execute", () => {
    // The runner wraps each statement chunk in a transaction, and
    // `CREATE INDEX CONCURRENTLY` is rejected inside one. Reaching for it here
    // would fail the deploy at apply time rather than in review, so the
    // limitation is asserted, not remembered. `VALIDATE CONSTRAINT` carries no
    // such restriction — it is transaction-safe — which is why the two-step
    // constraint path above is available and CONCURRENTLY is not.
    expect(migrationSql).not.toMatch(/CONCURRENTLY/i);
  });

  it("defaults existing stops to landing/endpoint", () => {
    expect(migration).toContain(
      `ALTER TABLE "flight_stops" ADD COLUMN IF NOT EXISTS "stop_kind" text NOT NULL DEFAULT 'landing'`,
    );
    expect(migration).toContain(
      `ALTER TABLE "flight_stops" ADD COLUMN IF NOT EXISTS "source_field" text NOT NULL DEFAULT 'endpoint'`,
    );
  });

  it("constrains the new enumerations", () => {
    expect(migration).toContain(`CHECK ("stop_kind" IN ('landing', 'waypoint'))`);
    expect(migration).toContain(
      `CHECK ("source_field" IN ('endpoint', 'route', 'manual'))`,
    );
  });

  it("keeps the landing read path indexed once waypoints share the table", () => {
    expect(migration).toContain(`CREATE INDEX IF NOT EXISTS "flight_stops_landing_idx"`);
    expect(migration).toContain(`WHERE "stop_kind" = 'landing'`);
  });

  it("makes source-row-key uniqueness partial so historical NULLs never collide", () => {
    // A plain unique index would treat every pre-existing flight as colliding
    // on NULL in some engines and would block the migration outright.
    expect(migration).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS "flights_user_source_row_key_unique"`,
    );
    expect(migration).toMatch(
      /flights_user_source_row_key_unique[\s\S]*?WHERE "source_row_key" IS NOT NULL/,
    );
    expect(migration).toMatch(
      /import_rows_batch_source_row_key_unique[\s\S]*?WHERE "source_row_key" IS NOT NULL/,
    );
  });

  it("adds the importer version to active-file uniqueness", () => {
    // Without this the old index makes "same bytes" mean "same outcome
    // forever", so a deployed importer fix can never reach the data it fixes.
    expect(migration).toContain(
      `ALTER TABLE "import_batches" ADD COLUMN IF NOT EXISTS "importer_version" integer NOT NULL DEFAULT 0`,
    );
    expect(migration).toContain(
      `DROP INDEX IF EXISTS "import_batches_user_hash_active_unique"`,
    );
    expect(migration).toContain(
      `ON "import_batches" ("user_id", "file_sha256", "importer_version")`,
    );
  });

  it("is re-runnable", () => {
    // Every statement is guarded, so a partially applied migration can be
    // replayed rather than repaired by hand. `ADD CONSTRAINT` has no
    // `IF NOT EXISTS` in Postgres, so it is idempotent only when the matching
    // `DROP CONSTRAINT IF EXISTS` precedes it — which this checks by name.
    //
    // Leading comments are stripped rather than used to skip the statement:
    // the previous filter dropped any chunk that opened with a comment, which
    // is most of them, so the guarantee was mostly unchecked.
    const statements = migration
      .split(STATEMENT_BREAKPOINT)
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    expect(statements.length).toBeGreaterThanOrEqual(15);
    const dropped = new Set(
      statements.flatMap((statement) => {
        const match = /DROP CONSTRAINT IF EXISTS "([^"]+)"/.exec(statement);
        return match ? [match[1]] : [];
      }),
    );
    for (const statement of statements) {
      const added = /ADD CONSTRAINT "([^"]+)"/.exec(statement);
      const guarded =
        /IF NOT EXISTS|IF EXISTS|DO \$\$/.test(statement) ||
        (added !== null && dropped.has(added[1])) ||
        // Validating an already-valid constraint is a no-op, so the
        // constraint-validation half of the two-step replays safely.
        /^ALTER TABLE [\s\S]*VALIDATE CONSTRAINT/.test(statement) ||
        // Self-excluding backfill: replaying it selects no rows.
        /^UPDATE[\s\S]*"fingerprint_version" <> 2/.test(statement);
      expect(
        guarded,
        `unguarded statement: ${statement.slice(0, 80)}`,
      ).toBe(true);
    }
  });
});

describe("every migration file", () => {
  const files = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();

  it("never hides the statement-breakpoint marker inside a comment", () => {
    // Found the hard way. The splitter is purely textual, so a marker written
    // inside an explanatory comment cuts the file mid-comment: the first
    // fragment ends in prose, Postgres rejects it as a syntax error, and the
    // deploy fails at apply time — long after review. A comment that needs to
    // name the marker must build it, never spell it.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(`${migrationsDirectory}/${file}`, "utf8");
      const commentedMarkers = contents
        .split("\n")
        .filter(
          (line) =>
            line.trim().startsWith("--") &&
            line.includes(STATEMENT_BREAKPOINT) &&
            line.trim() !== STATEMENT_BREAKPOINT,
        );
      expect(commentedMarkers, `${file}: marker inside a comment`).toEqual([]);
    }
  });

  it("produces only chunks that contain executable SQL", () => {
    for (const file of files) {
      const contents = readFileSync(`${migrationsDirectory}/${file}`, "utf8");
      const chunks = contents
        .split(STATEMENT_BREAKPOINT)
        .map((chunk) =>
          chunk
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        );
      for (const [index, chunk] of chunks.entries()) {
        expect(
          chunk.length,
          `${file}: chunk ${index} has no SQL`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("schema matches migration 0018", () => {
  const columns = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table).columns.map(({ name }) => name);

  it("declares the new columns on every touched table", () => {
    expect(columns(flightStops)).toEqual(
      expect.arrayContaining(["stop_kind", "source_field"]),
    );
    expect(columns(flights)).toEqual(
      expect.arrayContaining(["fingerprint_version", "source_row_key", "route_raw"]),
    );
    expect(columns(importBatches)).toEqual(
      expect.arrayContaining(["importer_version", "reprocessed_from_batch_id"]),
    );
    expect(columns(importRows)).toEqual(
      expect.arrayContaining(["source_row_key"]),
    );
  });

  it("defaults stop kind and source field so existing rows keep their meaning", () => {
    const config = getTableConfig(flightStops);
    const stopKind = config.columns.find(({ name }) => name === "stop_kind");
    const sourceField = config.columns.find(({ name }) => name === "source_field");
    expect(stopKind?.default).toBe("landing");
    expect(stopKind?.notNull).toBe(true);
    expect(sourceField?.default).toBe("endpoint");
    expect(sourceField?.notNull).toBe(true);
  });

  it("keeps the pre-versioning importer default at 0 so old batches restage", () => {
    const config = getTableConfig(importBatches);
    const importerVersion = config.columns.find(
      ({ name }) => name === "importer_version",
    );
    expect(importerVersion?.default).toBe(0);
    expect(importerVersion?.notNull).toBe(true);
  });
});
