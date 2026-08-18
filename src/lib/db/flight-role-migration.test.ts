import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL("../../../drizzle/migrations/0007_flight_role_provenance.sql", import.meta.url),
  ),
  "utf8",
);

describe("flight role provenance migration", () => {
  it("backfills only unambiguous immutable provenance and skips overrides", () => {
    expect(migration).toContain("count(DISTINCT expected_kind) = 1");
    expect(migration).toContain("count(DISTINCT expected_role) = 1");
    expect(migration).toContain("overrides.field IN ('kind', 'role')");
    expect(migration).toContain("ib.adapter_id = 'foreflight-v1'");
    expect(migration).toContain("ib.adapter_id = 'myflightradar24-v1'");
  });
});
