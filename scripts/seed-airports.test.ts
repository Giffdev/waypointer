import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  airportIdentifierAliases,
  parseOurAirportsCsv,
  type AirportReference,
} from "../src/lib/import/airport-resolution";
import {
  assignAirportSeedIds,
  type ExistingAirportIdentity,
} from "./airport-seed-plan";

const seedSource = readFileSync(
  fileURLToPath(new URL("./seed-airports.ts", import.meta.url)),
  "utf8",
);

describe("airport catalog refresh identity planning", () => {
  it("uses the pinned local source and never downloads mutable release data", () => {
    expect(seedSource).toContain("airport-catalog-release.json");
    expect(seedSource).toContain("source-checksum-mismatch");
    expect(seedSource).not.toContain("fetch(");
    expect(seedSource).not.toContain("Downloading");
  });

  it("preserves UUIDs by source identity while allowing unclaimed stale ICAO and IATA changes", () => {
    const references = [
      airportReference("SOURCE-A", "Airport A", 40, -120, "KAAA", "AAA"),
      airportReference("SOURCE-B", "Airport B", 41, -121, "KBBB", "BBB"),
    ];
    const existing = [
      existingAirport("id-a", "SOURCE-A", "KOLD", "OLD", "Airport A", 40, -120),
      existingAirport("id-b", "SOURCE-B", "KBBB", "BBB", "Airport B", 41, -121),
    ];

    const assignment = assignAirportSeedIds(
      references,
      existing,
      (reference) => reference.gpsCode,
      (reference) => reference.iataCode,
    );

    expect(assignment.ids).toEqual(["id-a", "id-b"]);
    expect(assignment).toMatchObject({
      matchedExisting: 2,
      created: 0,
      summary: {
        matchedBySourceIdent: 2,
        matchedLegacy: 0,
        collisions: 0,
        ambiguities: 0,
      },
    });
  });

  it("fails closed when source, ICAO, or IATA identifiers cross existing UUIDs", () => {
    const references = [
      airportReference("SOURCE-A", "Airport A", 40, -120, "KAAA", "AAA"),
      airportReference("SOURCE-B", "Airport B", 41, -121, "KBBB", "BBB"),
    ];
    const existing = [
      existingAirport("id-a", "SOURCE-A", "KBBB", "BBB", "Airport A", 40, -120),
      existingAirport("id-b", "SOURCE-B", "KAAA", "AAA", "Airport B", 41, -121),
    ];

    expect(() =>
      assignAirportSeedIds(
        references,
        existing,
        (reference) => reference.gpsCode,
        (reference) => reference.iataCode,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "crossed-identifiers",
      }),
    );
  });

  it("rejects duplicate incoming source identifiers before allocating IDs", () => {
    const createId = () => {
      throw new Error("ID allocation must not run.");
    };
    const duplicate = airportReference(
      "DUPLICATE",
      "Duplicate",
      40,
      -120,
    );

    expect(() =>
      assignAirportSeedIds(
        [duplicate, { ...duplicate, name: "Other row" }],
        [],
        (reference) => reference.gpsCode,
        (reference) => reference.iataCode,
        createId,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "duplicate-incoming-source-ident",
      }),
    );
  });

  it("never reassigns a sourced UUID to a different incoming airport", () => {
    const reference = airportReference(
      "NEW-SOURCE",
      "New Airport",
      40,
      -120,
      "KAAA",
    );
    const existing = [
      existingAirport(
        "historical-id",
        "HISTORICAL-SOURCE",
        "KAAA",
        null,
        "Historical Airport",
        40,
        -120,
      ),
    ];

    expect(() =>
      assignAirportSeedIds(
        [reference],
        existing,
        (candidate) => candidate.gpsCode,
        (candidate) => candidate.iataCode,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "identity-reassignment",
      }),
    );
  });

  it("adopts only one exact legacy row and rejects ambiguous legacy matches", () => {
    const reference = airportReference(
      "SOURCE-A",
      "Legacy Airport",
      40,
      -120,
      "KAAA",
    );
    const legacy = existingAirport(
      "legacy-id",
      null,
      "KAAA",
      null,
      "Legacy Airport",
      40,
      -120,
    );
    expect(
      assignAirportSeedIds(
        [reference],
        [legacy],
        (candidate) => candidate.gpsCode,
        (candidate) => candidate.iataCode,
      ),
    ).toMatchObject({
      ids: ["legacy-id"],
      summary: { matchedLegacy: 1, created: 0 },
    });

    expect(() =>
      assignAirportSeedIds(
        [reference],
        [
          legacy,
          { ...legacy, id: "other-legacy-id", icao: null },
        ],
        () => undefined,
        () => undefined,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "ambiguous-existing-identity",
      }),
    );
  });

  it("repairs the 0009 00A/K00A code-derived identity without changing its UUID", () => {
    const reference = airportReference(
      "00A",
      "Total RF Heliport",
      40.070985,
      -74.933689,
      "K00A",
    );
    reference.localCode = "00A";
    const migrated = existingAirport(
      "stable-00a-id",
      "K00A",
      "K00A",
      null,
      "Total RF Heliport",
      40.070985,
      -74.933689,
      "legacy-code-backfill",
    );
    migrated.localCode = "00A";

    expect(
      assignAirportSeedIds(
        [reference],
        [migrated],
        (candidate) => candidate.gpsCode,
        (candidate) => candidate.iataCode,
      ),
    ).toMatchObject({
      ids: ["stable-00a-id"],
      summary: {
        matchedBySourceIdent: 0,
        matchedLegacy: 1,
        created: 0,
      },
    });
  });

  it("rejects a reassigned code even when it directly matches a legacy source identifier", () => {
    const reference = airportReference(
      "REASSIGNED",
      "Replacement Airport",
      41,
      -121,
    );
    const migrated = existingAirport(
      "historical-id",
      "REASSIGNED",
      null,
      null,
      "Original Historical Airport",
      40,
      -120,
      "legacy-code-backfill",
    );

    expect(() =>
      assignAirportSeedIds(
        [reference],
        [migrated],
        () => undefined,
        () => undefined,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnosticCode: "identity-reassignment",
      }),
    );
  });

  it("preserves systematic FAA LID and ICAO-prefixed regional identities from 0009", () => {
    const references = [
      {
        ...airportReference(
          "00A",
          "Total RF Heliport",
          40.070985,
          -74.933689,
          "K00A",
        ),
        localCode: "00A",
      },
      {
        ...airportReference(
          "KW01",
          "Tonasket Municipal Airport",
          48.7248683333,
          -119.465634722,
          "KW01",
        ),
        localCode: "W01",
      },
      {
        ...airportReference(
          "KOMK",
          "Omak Airport",
          48.4644012451,
          -119.517997742,
          "KOMK",
          "OMK",
        ),
        localCode: "OMK",
      },
      {
        ...airportReference(
          "S18",
          "Forks Airport",
          47.937698,
          -124.396004,
        ),
        localCode: "S18",
      },
      {
        ...airportReference(
          "KUIL",
          "Quillayute Airport",
          47.936599731445,
          -124.56300354004,
          "KUIL",
          "UIL",
        ),
        localCode: "UIL",
      },
    ];
    const migratedSources = ["K00A", "KW01", "KOMK", "S18", "KUIL"];
    const existing = references.map((reference, index) => {
      const airport = existingAirport(
        `regional-${index}`,
        migratedSources[index],
        reference.gpsCode ?? null,
        reference.iataCode ?? null,
        reference.name,
        reference.latitude,
        reference.longitude,
        "legacy-code-backfill",
      );
      airport.localCode = reference.localCode ?? null;
      return airport;
    });

    expect(
      assignAirportSeedIds(
        references,
        existing,
        (reference) => reference.gpsCode,
        (reference) => reference.iataCode,
      ),
    ).toMatchObject({
      ids: existing.map(({ id }) => id),
      created: 0,
      summary: {
        matchedLegacy: 5,
        matchedBySourceIdent: 0,
      },
    });
  });

  it(
    "preserves every production-sized source UUID and records deterministic totals",
    () => {
      const references = parseOurAirportsCsv(
        readFileSync(
          fileURLToPath(
            new URL(
              "../data/private/reference/ourairports-airports.csv",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
      const icaoFrequency = frequencies(references, proposedIcaoCode);
      const iataFrequency = frequencies(
        references,
        (reference) => reference.iataCode,
      );
      const proposedIcao = (reference: AirportReference) => {
        const code = proposedIcaoCode(reference);
        return code && icaoFrequency.get(code) === 1 ? code : undefined;
      };
      const proposedIata = (reference: AirportReference) =>
        reference.iataCode && iataFrequency.get(reference.iataCode) === 1
          ? reference.iataCode
          : undefined;
      const existing = references.map((reference, index) =>
        existingAirport(
          `airport-${index}`,
          reference.ident,
          proposedIcao(reference) ?? null,
          proposedIata(reference) ?? null,
          reference.name,
          reference.latitude,
          reference.longitude,
        ),
      );
      existing[0].icao = null;
      existing[0].iata = null;

      const assignment = assignAirportSeedIds(
        references,
        existing,
        proposedIcao,
        proposedIata,
        () => {
          throw new Error("Every reviewed source identity must be reused.");
        },
      );

      expect(references).toHaveLength(85_836);
      expect(references.flatMap(airportIdentifierAliases)).toHaveLength(182_149);
      expect(assignment.ids).toEqual(existing.map(({ id }) => id));
      expect(assignment).toMatchObject({
        matchedExisting: 85_836,
        created: 0,
        summary: {
          incomingCount: 85_836,
          matchedBySourceIdent: 85_836,
          collisions: 0,
          ambiguities: 0,
        },
      });
    },
    30_000,
  );
});

function proposedIcaoCode(reference: AirportReference) {
  return (
    reference.gpsCode ||
    (/^[A-Z]{4}$/.test(reference.ident) ? reference.ident : undefined)
  );
}

function frequencies(
  references: AirportReference[],
  select: (reference: AirportReference) => string | undefined,
) {
  const values = new Map<string, number>();
  for (const reference of references) {
    const value = select(reference);
    if (value) values.set(value, (values.get(value) ?? 0) + 1);
  }
  return values;
}

function airportReference(
  ident: string,
  name: string,
  latitude: number,
  longitude: number,
  gpsCode?: string,
  iataCode?: string,
): AirportReference {
  return {
    ident,
    type: "small_airport",
    name,
    latitude,
    longitude,
    isoCountry: "US",
    municipality: "Test",
    scheduledService: false,
    gpsCode,
    iataCode,
  };
}

function existingAirport(
  id: string,
  sourceIdent: string | null,
  icao: string | null,
  iata: string | null,
  name: string,
  latitude: number,
  longitude: number,
  sourceIdentProvenance = sourceIdent
    ? `ourairports-sha256:${"a".repeat(64)}`
    : null,
): ExistingAirportIdentity {
  return {
    id,
    sourceIdent,
    sourceIdentProvenance,
    icao,
    iata,
    localCode: null,
    name,
    latitude,
    longitude,
  };
}
