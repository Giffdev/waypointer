import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("map view preference migration", () => {
  it("defaults unset profiles to the existing globe without rewriting rows", () => {
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "drizzle",
        "migrations",
        "0013_map_view_mode_preference.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("DEFAULT 'globe' NOT NULL");
    expect(migration).toContain("IN ('globe', 'flat')");
    expect(migration).not.toMatch(/\bUPDATE\b/i);
  });
});
