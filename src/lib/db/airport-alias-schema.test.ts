import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0009_airport_identifier_aliases.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const nameSearchMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0010_airport_name_search.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const provenanceMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0015_airport_source_provenance.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("airport alias schema", () => {
  it("stores version-stable source identifiers and prioritized aliases", () => {
    expect(migration).toContain('"source_ident"');
    expect(migration).toContain('"airport_aliases"');
    expect(migration).toContain("'faa-lid'");
    expect(migration).toContain('"airport_aliases_code_priority_idx"');
  });

  it("persists catalog keywords and bounded phonetic search keys", () => {
    expect(nameSearchMigration).toContain('"search_keywords"');
    expect(nameSearchMigration).toContain('"search_key"');
    expect(nameSearchMigration).toContain('"airports_search_key_idx"');
  });

  it("marks 0009 code-derived identities and content-addresses verified sources", () => {
    expect(provenanceMigration).toContain('"source_ident_provenance"');
    expect(provenanceMigration).toContain("'legacy-code-backfill'");
    expect(provenanceMigration).toContain("ourairports-sha256:");
    expect(provenanceMigration).toContain(
      '"airports_source_ident_provenance_valid"',
    );
  });
});
