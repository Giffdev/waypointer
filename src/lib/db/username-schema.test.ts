import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { users } from "./schema";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0005_editable_usernames.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const publicHandleMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0017_public_share_handles.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("editable username schema", () => {
  it("keeps case-insensitive uniqueness and the shared format authoritative", () => {
    const config = getTableConfig(users);

    expect(config.indexes.map((index) => index.config.name)).toContain(
      "users_username_unique",
    );
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "users_username_format",
    );
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "users_public_handle_not_reserved",
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "users_username_unique"',
    );
    expect(migration).toContain('UPDATE "users"');
    expect(migration).toContain('left(replace("id"::text');
    expect(migration).toContain(
      'ADD CONSTRAINT "users_username_format"',
    );
    expect(publicHandleMigration).not.toContain(
      "public_handle_configured_at",
    );
    expect(publicHandleMigration).toContain(
      'ADD CONSTRAINT "users_public_handle_not_reserved"',
    );
    for (const route of ["api", "auth", "map", "settings", "shared"]) {
      expect(publicHandleMigration).toContain(`'${route}'`);
    }
  });
});
