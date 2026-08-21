import { describe, expect, it } from "vitest";
import {
  quotedPostgresIdentifier,
  runtimeDatabaseRole,
  runtimeProjectionGrantStatements,
} from "./safe-migrate";

describe("production migration runtime grants", () => {
  it("derives and safely quotes the runtime role from DATABASE_URL", () => {
    expect(
      runtimeDatabaseRole({
        DATABASE_URL:
          "postgresql://flight_map_runtime:secret@db.example.test/flight_map",
      }),
    ).toBe("flight_map_runtime");
    expect(quotedPostgresIdentifier('runtime"role')).toBe(
      '"runtime""role"',
    );
  });

  it("grants only the current public handle projection", () => {
    expect(runtimeProjectionGrantStatements("flight_map_runtime")).toEqual([
      'GRANT EXECUTE ON FUNCTION public_map_projection_by_handle(text) TO "flight_map_runtime"',
    ]);
  });

  it("fails closed when the runtime role cannot be determined", () => {
    expect(() => runtimeDatabaseRole({})).toThrow(/DATABASE_URL is required/);
  });
});
