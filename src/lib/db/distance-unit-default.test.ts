import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { userProfiles } from "./schema";

describe("profile distance unit default", () => {
  it("uses nautical miles for new profiles without rewriting existing choices", async () => {
    const config = getTableConfig(userProfiles);
    const distanceUnit = config.columns.find(
      ({ name }) => name === "distance_unit",
    );
    const migration = await readFile(
      "drizzle/migrations/0011_nautical_miles_profile_default.sql",
      "utf8",
    );

    expect(distanceUnit?.default).toBe("nautical_miles");
    expect(migration).toContain(
      `ALTER COLUMN "distance_unit" SET DEFAULT 'nautical_miles'`,
    );
    expect(migration).not.toMatch(/\bUPDATE\b/i);
  });
});
