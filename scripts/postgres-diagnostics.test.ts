import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import {
  AirportCatalogSafetyError,
  assertNoRawPostgresNotice,
  formatSafePostgresError,
  safePostgresClientOptions,
} from "./postgres-diagnostics";

describe("safe PostgreSQL diagnostics", () => {
  it("unwraps a Drizzle error and emits only allowlisted PostgreSQL metadata", () => {
    const postgresError = Object.assign(
      new Error("duplicate value user@example.test token=secret-token"),
      {
        name: "PostgresError",
        code: "23505",
        severity: "ERROR",
        schema_name: "public",
        table_name: "airports",
        constraint_name: "airports_source_ident_unique",
        routine: "_bt_check_unique",
        detail: "Key (source_ident)=(PRIVATE-ROW) already exists.",
        hint: "Bound value was PRIVATE-ROW.",
        query: "insert into airports values ('PRIVATE-ROW')",
        parameters: ["PRIVATE-ROW", "user@example.test"],
        file: "nbtinsert.c",
        connectionString:
          "******secret@db.example.test/flight_map",
      },
    );
    const drizzleError = new DrizzleQueryError(
      "insert into airports values ($1)",
      ["PRIVATE-ROW"],
      postgresError,
    );

    const diagnostic = formatSafePostgresError(drizzleError);

    expect(diagnostic).toBe(
      "Airport catalog operation failed " +
        "[code=23505; severity=ERROR; schema_name=public; table_name=airports; " +
        "constraint_name=airports_source_ident_unique; routine=_bt_check_unique]",
    );
    for (const forbidden of [
      "insert into",
      "PRIVATE-ROW",
      "params",
      "user@example.test",
      "secret-token",
      "db.example.test",
      "nbtinsert.c",
      "Bound value",
    ]) {
      expect(diagnostic).not.toContain(forbidden);
    }
  });

  it("emits fixed operational reasons without unsafe messages", () => {
    const error = new AirportCatalogSafetyError("crossed-identifiers", {
      candidateCount: 2,
      referenceIndex: 7,
    });
    error.message =
      "unsafe row payload PRIVATE-ROW and ******secret@db";

    expect(formatSafePostgresError(error)).toBe(
      "Airport catalog operation blocked " +
        "[reason=crossed-identifiers; candidateCount=2; referenceIndex=7]",
    );
  });

  it("uses a fixed fallback for unknown errors", () => {
    expect(
      formatSafePostgresError(
        new Error("SQL params, credentials, filename.csv, row payload"),
      ),
    ).toBe("Airport catalog operation failed.");
  });

  it("suppresses PostgreSQL notices instead of emitting server text", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safePostgresClientOptions.onnotice({
      code: "00000",
      severity: "NOTICE",
      message:
        "SQL insert params=PRIVATE-ROW secret-token filename.csv user@example.test",
      detail: "row payload",
      hint: "credential",
      file: "unsafe.c",
    });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it("rejects persisted output that contains raw notice fields", () => {
    expect(() =>
      assertNoRawPostgresNotice(
        "{ severity_local: 'NOTICE', message: 'private', file: 'dropcmds.c', line: '528' }",
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "candidate-provenance-mismatch",
      }),
    );
    expect(() =>
      assertNoRawPostgresNotice("Focused tests passed: 51/51.\n"),
    ).not.toThrow();
  });
});
