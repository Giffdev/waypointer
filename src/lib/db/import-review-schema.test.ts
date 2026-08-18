import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { duplicateCandidates, flightOverrides, importRows } from "./schema";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../drizzle/migrations/0003_import_review.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("import review persistence schema", () => {
  it("supports staged and existing-flight candidate ownership", () => {
    const config = getTableConfig(duplicateCandidates);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "batch_id",
        "import_row_id",
        "candidate_import_row_id",
        "candidate_flight_id",
        "candidate_scope",
        "resolved_at",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "duplicate_candidates_user_row_rule_unique",
    );
    expect(migration).toContain(
      'REFERENCES "import_rows"("id", "user_id", "batch_id")',
    );
  });

  it("retains owner RLS and correction provenance tables", () => {
    expect(getTableConfig(flightOverrides).name).toBe("flight_overrides");
    expect(
      getTableConfig(importRows).indexes.map((index) => index.config.name),
    ).toContain("import_rows_id_user_batch_unique");
    expect(migration).not.toContain("DISABLE ROW LEVEL SECURITY");
  });
});
