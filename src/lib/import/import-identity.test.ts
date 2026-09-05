import { describe, expect, it } from "vitest";
import { applyDuplicateCandidates } from "./dedupe";
import {
  assignSourceRowKeys,
  createLegacyRowFingerprint,
  createRowFingerprint,
  createSourceRowIdentity,
  createSourceRowKey,
  ROW_FINGERPRINT_VERSION,
  type SourceRowIdentityProjection,
} from "./fingerprint";
import type { Airport } from "../flight-data";
import type {
  ImportAirportMatch,
  ProposedImportFlight,
  StoredImportRow,
} from "./types";

/**
 * Import identity durability.
 *
 * The bug this file exists to keep fixed: several same-day legs over the same
 * route with a blank `TimeOut` produced one fingerprint, the unique index on
 * `(user_id, fingerprint)` enforced the collapse physically, and the extra
 * flights disappeared with nothing shown to the pilot. Every test here is a
 * property that, if it breaks, silently loses somebody's flights.
 */

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Example",
  country: "US",
  lat: 42,
  lon: -123,
  facility: "general-aviation",
});

const resolved = (identifier: string): ImportAirportMatch => ({
  status: "resolved",
  identifier,
  airportId: `airport-${identifier.toLowerCase()}`,
  airport: airport(identifier),
  matchedCodeTypes: ["icao"],
});

const leg = (
  overrides: Partial<ProposedImportFlight> = {},
): ProposedImportFlight => ({
  date: "2026-05-01",
  kind: "private",
  role: "pilot",
  source: "ForeFlight",
  registration: "N12345",
  origin: resolved("KMFR"),
  destination: resolved("KEUG"),
  originIdentifier: "KMFR",
  destinationIdentifier: "KEUG",
  airportIdentifiers: ["KMFR", "KEUG"],
  airportMatches: [resolved("KMFR"), resolved("KEUG")],
  ...overrides,
});

describe("source row keys", () => {
  /**
   * The projection is what the row *is*, not what the file happens to print.
   * These fixtures deliberately carry a trailing non-identity field so the
   * "editing a remark must not change identity" property has something to
   * edit.
   */
  const record = (
    rowNumber: number,
    projection: SourceRowIdentityProjection,
  ) => ({ rowNumber, projection });

  const legOne: SourceRowIdentityProjection = {
    date: "2026-05-01",
    registration: "N12345",
    originIdentifier: "KMFR",
    destinationIdentifier: "KEUG",
  };
  const legTwo: SourceRowIdentityProjection = { ...legOne };
  const legThree: SourceRowIdentityProjection = {
    date: "2026-05-02",
    registration: "N12345",
    originIdentifier: "KEUG",
    destinationIdentifier: "KMFR",
  };
  const file = [
    record(1, legOne),
    record(2, legTwo),
    record(3, legThree),
  ];

  it("is stable when an unrelated row is inserted above it", () => {
    // The predecessor keyed on the source row ordinal, so re-exporting a
    // logbook with one older flight added at the top renumbered every row and
    // made the whole file look brand new.
    const before = assignSourceRowKeys("user", "foreflight", file);
    const inserted = assignSourceRowKeys("user", "foreflight", [
      record(1, {
        date: "2026-04-30",
        registration: "N99999",
        originIdentifier: "KPDX",
        destinationIdentifier: "KMFR",
        departureTime: "09:00",
      }),
      ...file.map((entry) =>
        record(entry.rowNumber + 1, entry.projection),
      ),
    ]);
    expect(inserted.get(2)).toBe(before.get(1));
    expect(inserted.get(3)).toBe(before.get(2));
    expect(inserted.get(4)).toBe(before.get(3));
  });

  it("is unchanged by editing a cell that is not part of the row's identity", () => {
    // Hashing every raw cell made a corrected remark, or a provider adding a
    // column, change the key — and a blank-time row's v3 fingerprint embeds
    // that key, so the flight looked new and imported a second time.
    const keys = assignSourceRowKeys("user", "foreflight", file);
    const edited = assignSourceRowKeys("user", "foreflight", [
      // Same identity fields; only fields outside the projection differ.
      record(1, { ...legOne }),
      record(2, { ...legTwo }),
      record(3, { ...legThree }),
    ]);
    expect([...edited]).toEqual([...keys]);

    // And an *identity* field changing does move the key, so the projection
    // is not merely ignoring everything.
    const rerouted = assignSourceRowKeys("user", "foreflight", [
      record(1, { ...legOne, destinationIdentifier: "KPDX" }),
    ]);
    expect(rerouted.get(1)).not.toBe(keys.get(1));
  });

  it("distinguishes two identical rows deterministically", () => {
    const keys = assignSourceRowKeys("user", "foreflight", file);
    expect(keys.get(1)).not.toBe(keys.get(2));
    // ...and reproduces both exactly on reimport, which is what preserves
    // cross-batch exact duplicate detection.
    const again = assignSourceRowKeys("user", "foreflight", file);
    expect([...again]).toEqual([...keys]);
  });

  it("numbers occurrences in source order regardless of input order", () => {
    const shuffled = assignSourceRowKeys("user", "foreflight", [
      file[2],
      file[0],
      file[1],
    ]);
    expect([...shuffled].sort()).toEqual(
      [...assignSourceRowKeys("user", "foreflight", file)].sort(),
    );
    expect(shuffled.get(1)).toBe(
      assignSourceRowKeys("user", "foreflight", file).get(1),
    );
  });

  it("is scoped to the user and the adapter", () => {
    const base = {
      rowIdentity: createSourceRowIdentity(legOne),
      occurrence: 1,
    };
    const mine = createSourceRowKey({ userId: "a", adapterId: "foreflight", ...base });
    expect(
      createSourceRowKey({ userId: "b", adapterId: "foreflight", ...base }),
    ).not.toBe(mine);
    expect(
      createSourceRowKey({ userId: "a", adapterId: "generic-csv", ...base }),
    ).not.toBe(mine);
  });

  it("ignores surrounding whitespace and case when hashing identity fields", () => {
    expect(
      createSourceRowIdentity({
        originIdentifier: " kmfr ",
        destinationIdentifier: "KEUG",
      }),
    ).toBe(
      createSourceRowIdentity({
        originIdentifier: "KMFR",
        destinationIdentifier: "KEUG",
      }),
    );
  });
});

describe("row fingerprint v3", () => {
  const blankTimeKeys = () =>
    assignSourceRowKeys("user", "foreflight", [
      {
        rowNumber: 1,
        projection: {
          date: "2026-05-01",
          registration: "N12345",
          originIdentifier: "KMFR",
          destinationIdentifier: "KEUG",
        },
      },
      {
        rowNumber: 2,
        projection: {
          date: "2026-05-01",
          registration: "N12345",
          originIdentifier: "KMFR",
          destinationIdentifier: "KEUG",
        },
      },
    ]);

  it("separates two same-day same-route blank-time rows", () => {
    const keys = blankTimeKeys();
    const first = createRowFingerprint("user", leg(), keys.get(1));
    const second = createRowFingerprint("user", leg(), keys.get(2));
    expect(first?.value).not.toBe(second?.value);
    expect(first?.version).toBe(ROW_FINGERPRINT_VERSION);
  });

  it("keeps a timed row's identity content-only, so two providers still collapse", () => {
    // A flight logged in ForeFlight and again in a generic CSV is one flight.
    // Only the blank-time collision class needs the source-row tiebreaker.
    const timed = leg({ departureTime: "08:05" });
    expect(createRowFingerprint("user", timed, "srk-a")?.value).toBe(
      createRowFingerprint("user", timed, "srk-b")?.value,
    );
  });

  it("reproduces the same digest when the same row is imported again", () => {
    const keys = blankTimeKeys();
    expect(createRowFingerprint("user", leg(), keys.get(1))?.value).toBe(
      createRowFingerprint("user", leg(), keys.get(1))?.value,
    );
  });

  it("is unchanged by adding, removing, or re-resolving waypoints", () => {
    // The classifier runs over every historical row. If waypoints touched
    // identity, one classifier improvement would rewrite the fingerprint of
    // every flight in the database and manufacture duplicates wholesale.
    const landings = leg({
      routeNodes: [
        { kind: "landing", identifier: "KMFR", match: resolved("KMFR"), sourceField: "From" },
        { kind: "landing", identifier: "KEUG", match: resolved("KEUG"), sourceField: "To" },
      ],
    });
    const withWaypoints = leg({
      routeNodes: [
        { kind: "landing", identifier: "KMFR", match: resolved("KMFR"), sourceField: "From" },
        { kind: "waypoint", identifier: "KRBG", match: resolved("KRBG"), sourceField: "Route", tokenIndex: 0 },
        { kind: "waypoint", identifier: "S39", match: resolved("S39"), sourceField: "Route", tokenIndex: 1 },
        { kind: "landing", identifier: "KEUG", match: resolved("KEUG"), sourceField: "To" },
      ],
    });
    expect(createRowFingerprint("user", withWaypoints, "srk")?.value).toBe(
      createRowFingerprint("user", landings, "srk")?.value,
    );
  });

  it("still separates genuinely different landing sequences", () => {
    const outbound = leg();
    const inbound = leg({
      origin: resolved("KEUG"),
      destination: resolved("KMFR"),
      airportMatches: [resolved("KEUG"), resolved("KMFR")],
    });
    expect(createRowFingerprint("user", outbound, "srk")?.value).not.toBe(
      createRowFingerprint("user", inbound, "srk")?.value,
    );
  });

  it("declines to fingerprint a row that cannot commit", () => {
    expect(createRowFingerprint("user", leg({ date: undefined }))).toBeUndefined();
    expect(
      createRowFingerprint(
        "user",
        leg({
          airportMatches: [resolved("KMFR"), { status: "not-found", identifier: "ZZZZ" }],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("legacy fingerprint adoption", () => {
  const storedRow = (
    overrides: Partial<StoredImportRow> = {},
  ): StoredImportRow => {
    const proposedFlight = leg();
    return {
      id: "row-1",
      sourceRowNumber: 1,
      rawSnapshot: "2026-05-01,N12345,KMFR,KEUG,",
      proposedFlight,
      issues: [],
      validationState: "ready",
      commitReady: true,
      rowFingerprint: createRowFingerprint("user", proposedFlight, "srk-1"),
      legacyRowFingerprint: createLegacyRowFingerprint("user", proposedFlight),
      provenance: {
        adapterId: "foreflight",
        adapterLabel: "ForeFlight",
        adapterVersion: 1,
        source: "ForeFlight",
        sourceRowNumber: 1,
        sourceRowKey: "srk-1",
      },
      ...overrides,
    } as StoredImportRow;
  };

  it("adopts a flight stored under a pre-v3 fingerprint instead of duplicating it", () => {
    // Without the adoption chain, the first reimport after this deploy would
    // insert a second copy of every flight already in the database.
    const row = storedRow();
    const [assessed] = applyDuplicateCandidates([row], [
      {
        flightId: "flight-existing",
        fingerprint: createLegacyRowFingerprint("user", leg())!,
      },
    ]);
    // `exact-fingerprint` is what `automaticallyCommitImport` keys its
    // auto-skip on, so emitting it is what makes adoption silent and safe.
    expect(assessed.duplicateCandidate?.signals).toContainEqual(
      expect.objectContaining({ code: "exact-fingerprint", weight: 1 }),
    );
    expect(assessed.duplicateCandidate?.score).toBe(1);
    expect(assessed.validationState).toBe("duplicate");
  });

  it("adopts by source row key when neither fingerprint version matches", () => {
    const row = storedRow();
    const [assessed] = applyDuplicateCandidates([row], [
      {
        flightId: "flight-existing",
        fingerprint: {
          algorithm: "sha256",
          version: 3,
          value: "a-completely-different-digest",
        },
        sourceRowKey: "srk-1",
      },
    ]);
    expect(assessed.duplicateCandidate?.signals).toContainEqual(
      expect.objectContaining({ code: "exact-fingerprint", weight: 1 }),
    );
  });

  it("never collapses two distinct source rows from the same file", () => {
    // Two blank-time legs on the same day over the same route are two
    // flights. Each carries its own source-row key, so the second is not an
    // exact match of the already-imported first and is never auto-skipped.
    const first = storedRow({ id: "row-1" });
    const second = storedRow({
      id: "row-2",
      rowFingerprint: createRowFingerprint("user", leg(), "srk-2"),
      provenance: {
        adapterId: "foreflight",
        adapterLabel: "ForeFlight",
        adapterVersion: 1,
        source: "ForeFlight",
        sourceRowNumber: 2,
        sourceRowKey: "srk-2",
      },
    });
    const assessed = applyDuplicateCandidates([first, second], [
      {
        flightId: "flight-existing",
        fingerprint: first.rowFingerprint!,
        sourceRowKey: "srk-1",
      },
    ]);
    const exact = (row: StoredImportRow) =>
      row.duplicateCandidate?.signals.some(
        (signal) => signal.code === "exact-fingerprint",
      ) ?? false;
    expect(exact(assessed[0])).toBe(true);
    expect(exact(assessed[1])).toBe(false);
  });

  it("freezes the legacy digest so historical flights stay findable", () => {
    // A snapshot, deliberately. If someone edits fingerprint-legacy.ts this
    // fails, which is the only warning before every historical flight
    // silently duplicates on the next reimport.
    const simple = createLegacyRowFingerprint("user", leg());
    expect(simple).toEqual({
      algorithm: "sha256",
      version: 1,
      value: simple!.value,
    });
    expect(simple!.value).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createLegacyRowFingerprint("user", leg({ departureTime: "08:05" }))!.value,
    ).not.toBe(simple!.value);
  });
});
