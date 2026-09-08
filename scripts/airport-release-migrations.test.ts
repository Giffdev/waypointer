import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AIRPORT_RELEASE_BOUNDARY_FLOOR_TAG,
  AIRPORT_RELEASE_SCOPE,
  airportMigrationBoundaryName,
  airportMigrationBoundaryTags,
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
      "0018_import_identity_and_route_waypoints",
      "0019_live_shared_maps",
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
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0018_import_identity_and_route_waypoints"),
        manifest,
        "production",
      ),
    ).toBe("0018");
    expect(
      validateAirportMigrationLedger(
        rowsThrough("0019_live_shared_maps"),
        manifest,
        "production",
      ),
    ).toBe("0019");
  });

  it("always admits the newest migration as a before-boundary", async () => {
    // This is the invariant that keeps going stale: a migration lands, the
    // boundary list is not extended, and the first production database to
    // apply it is reported as a ledger mismatch — so the release tooling
    // refuses to run against current production and nobody finds out until
    // the deploy. The boundary set is derived from the manifest for that
    // reason, and this asserts the derivation rather than a hardcoded tag.
    const manifest = await loadAirportReleaseMigrationManifest();
    const newest = manifest.entries.at(-1)!;
    const boundaryTags = airportMigrationBoundaryTags(manifest);

    expect(boundaryTags.at(-1)).toBe(newest.tag);
    expect(boundaryTags.at(0)).toBe(AIRPORT_RELEASE_BOUNDARY_FLOOR_TAG);
    expect(manifest.permittedBefore.map(({ tag }) => tag)).toEqual(
      boundaryTags,
    );

    // Every boundary from the floor to the newest is a contiguous, correctly
    // counted prefix of the ledger — no gaps, no stale counts.
    for (const [index, entry] of manifest.entries.entries()) {
      const boundary = manifest.permittedBefore.find(
        ({ tag }) => tag === entry.tag,
      );
      if (!boundaryTags.includes(entry.tag)) {
        expect(boundary).toBeUndefined();
        continue;
      }
      expect(boundary?.appliedCount).toBe(index + 1);
      expect(airportMigrationBoundaryName(entry.tag)).toBe(
        entry.tag.slice(0, 4),
      );
    }

    // And the inventory check enforces it: dropping the newest boundary must
    // fail, so this cannot silently rot again.
    expect(() =>
      validateAirportMigrationInventory(
        {
          ...manifest,
          permittedBefore: manifest.permittedBefore.filter(
            ({ tag }) => tag !== newest.tag,
          ),
        },
        {
          version: "7",
          dialect: "postgresql",
          entries: manifest.entries.map((migration) => ({
            idx: migration.order,
            version: "7",
            when: migration.createdAt,
            tag: migration.tag,
            breakpoints: true,
          })),
        },
        manifest.entries.map(({ tag }) => `${tag}.sql`),
        Object.fromEntries(
          manifest.entries.map(({ tag, sha256 }) => [tag, sha256]),
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "migration-ledger-mismatch",
      }),
    );
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

  it("rolls 0019 back to a ledger boundary its schema verification accepts", async () => {
    // The rollback re-attaches the invalidation triggers, and
    // `verifyProductMigrationState` asserts those triggers are absent at
    // boundary 0019 and present before it. A rollback that restores the
    // schema but leaves 0019 in the ledger therefore reports schema drift
    // and blocks the release tooling on the build it was meant to rescue.
    const manifest = await loadAirportReleaseMigrationManifest();
    const rollback = readFileSync(
      fileURLToPath(
        new URL(
          "../drizzle/rollback/0019_live_shared_maps_down.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const liveSharedMaps = manifest.entries.find(
      ({ tag }) => tag === "0019_live_shared_maps",
    );
    expect(liveSharedMaps).toBeDefined();
    // Comment text is not a rollback step: only what the migration role will
    // actually execute counts.
    const executable = rollback.replace(/--[^\r\n]*/g, "");
    expect(executable).toMatch(
      /CREATE TRIGGER "flights_invalidate_selected_share"/,
    );
    expect(executable).toMatch(
      /CREATE TRIGGER "flight_stops_invalidate_selected_share"/,
    );

    // Exactly one ledger statement, addressed by 0019's pinned manifest hash
    // — never by count arithmetic, which would trim whichever row happened to
    // be last.
    const ledgerDeletes =
      executable.match(
        /delete\s+from\s+"?drizzle"?\s*\.\s*"?__drizzle_migrations"?[^;]*;/gi,
      ) ?? [];
    expect(ledgerDeletes).toHaveLength(1);
    const pinnedHashes = ledgerDeletes[0]!.match(/'[a-f0-9]{64}'/g) ?? [];
    expect(pinnedHashes).toEqual([`'${liveSharedMaps!.sha256}'`]);

    // Executed against the ledger this release produces, that statement is
    // the difference between boundary 0019 and boundary 0018.
    const rows = manifest.entries.map((migration) => ({
      hash: migration.sha256,
      created_at: migration.createdAt,
    }));
    expect(validateAirportMigrationLedger(rows, manifest, "production")).toBe(
      "0019",
    );
    const deletedHash = pinnedHashes[0]!.slice(1, -1);
    const rolledBack = rows.filter((row) => row.hash !== deletedHash);
    expect(rolledBack).toHaveLength(rows.length - 1);
    expect(
      validateAirportMigrationLedger(rolledBack, manifest, "production"),
    ).toBe("0018");
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
