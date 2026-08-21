import { describe, expect, it } from "vitest";
import {
  AIRPORT_RELEASE_SCOPE,
  applyPendingAirportMigrations,
  loadAirportReleaseMigrationManifest,
  type UnsafeSqlClient,
  validateAirportMigrationInventory,
  validateAirportMigrationLedger,
} from "./airport-release-migrations";

describe("airport release migration ledger targeting", () => {
  it("manifests every migration and accepts only exact reviewed boundaries", async () => {
    const manifest = await loadAirportReleaseMigrationManifest();
    const rowsThrough = (tag: string) => {
      const index = manifest.entries.findIndex(
        (migration) => migration.tag === tag,
      );
      return manifest.entries.slice(0, index + 1).map((migration) => ({
        hash: migration.sha256,
        created_at: migration.createdAt,
      }));
    };

    expect(
      manifest.entries.slice(10).map(({ tag }) => tag),
    ).toEqual([
      "0009_airport_identifier_aliases",
      "0010_airport_name_search",
      "0011_nautical_miles_profile_default",
      "0012_multi_stop_flight_routes",
      "0013_map_view_mode_preference",
      "0014_fix_flight_share_invalidation",
      "0015_airport_source_provenance",
      "0016_serialize_owner_flight_sharing",
      "0017_public_share_handles",
    ]);
    expect(manifest.releaseScope).toEqual(AIRPORT_RELEASE_SCOPE);
    expect(() =>
      validateAirportMigrationLedger(
        rowsThrough("0008_read_only_map_sharing"),
        manifest,
        "production",
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0014_fix_flight_share_invalidation"),
        manifest,
        "production",
      ),
    ).toBe("0014");
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0015_airport_source_provenance"),
        manifest,
        "production",
      ),
    ).toBe("0015");
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0016_serialize_owner_flight_sharing"),
        manifest,
        "production",
      ),
    ).toBe("0016");
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0017_public_share_handles"),
        manifest,
        "production",
      ),
    ).toBe("0017");
  });

  it("recognizes reviewed later boundaries without applying them through the airport release", async () => {
    const manifest = await loadAirportReleaseMigrationManifest();
    const calls: Array<{ query: string; parameters?: unknown[] }> = [];
    const sql = {
      async unsafe(query: string, parameters?: unknown[]) {
        calls.push({ query, parameters });
        return query.includes("count(*)")
          ? [{ count: 16 }]
          : [];
      },
    } as UnsafeSqlClient;

    await applyPendingAirportMigrations(sql);

    const ledgerWrites = calls.filter(({ query }) =>
      query.includes("insert into drizzle.__drizzle_migrations"),
    );
    expect(ledgerWrites).toHaveLength(1);
    expect(ledgerWrites[0]?.parameters).toEqual([
      manifest.entries.find(
        ({ tag }) => tag === "0015_airport_source_provenance",
      )?.sha256,
      manifest.entries.find(
        ({ tag }) => tag === "0015_airport_source_provenance",
      )?.createdAt,
    ]);
    expect(
      calls.some(({ query }) =>
        query.includes("invalidate_selected_map_share_for_stop"),
      ),
    ).toBe(false);

    const currentCalls: string[] = [];
    await applyPendingAirportMigrations({
      async unsafe(query: string) {
        currentCalls.push(query);
        return query.includes("count(*)")
          ? [{ count: 18 }]
          : [];
      },
    });
    expect(currentCalls).toHaveLength(1);
  });

  it("rejects unknown hashes, missing entries, and partial boundaries", async () => {
    const manifest = await loadAirportReleaseMigrationManifest();
    const rows = manifest.entries.slice(0, 11).map((migration) => ({
      hash: migration.sha256,
      created_at: migration.createdAt,
    }));
    expect(() =>
      validateAirportMigrationLedger(rows, manifest, "production"),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );

    const tampered = manifest.entries.slice(0, 10).map((migration) => ({
      hash: migration.sha256,
      created_at: migration.createdAt,
    }));
    tampered[9].hash = "0".repeat(64);
    expect(() =>
      validateAirportMigrationLedger(tampered, manifest, "production"),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
  });

  it("refuses extra, missing, reordered, or modified migration files", async () => {
    const manifest = await loadAirportReleaseMigrationManifest();
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: manifest.entries.map((migration) => ({
        idx: migration.order,
        version: "7",
        when: migration.createdAt,
        tag: migration.tag,
        breakpoints: true,
      })),
    };
    const files = manifest.entries.map(({ tag }) => `${tag}.sql`);
    const hashes = Object.fromEntries(
      manifest.entries.map(({ tag, sha256 }) => [tag, sha256]),
    );
    expect(() =>
      validateAirportMigrationInventory(
        manifest,
        journal,
        files,
        hashes,
      ),
    ).not.toThrow();
    for (const invalidFiles of [
      files.slice(1),
      [...files, "0017_unreviewed.sql"],
    ]) {
      expect(() =>
        validateAirportMigrationInventory(
          manifest,
          journal,
          invalidFiles,
          hashes,
        ),
      ).toThrow(
        expect.objectContaining({
          diagnosticCode: "migration-ledger-mismatch",
        }),
      );
    }
    expect(() =>
      validateAirportMigrationInventory(
        manifest,
        {
          ...journal,
          entries: [journal.entries[1]!, journal.entries[0]!, ...journal.entries.slice(2)],
        },
        files,
        hashes,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
    expect(() =>
      validateAirportMigrationInventory(
        manifest,
        journal,
        files,
        { ...hashes, "0014_fix_flight_share_invalidation": "0".repeat(64) },
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
  });

  it("allows an empty ledger only for disposable test databases", async () => {
    const manifest = await loadAirportReleaseMigrationManifest();
    expect(validateAirportMigrationLedger([], manifest, "test")).toBe(
      "empty",
    );
    expect(() =>
      validateAirportMigrationLedger([], manifest, "production"),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
  });
});
