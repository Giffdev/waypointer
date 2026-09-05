import { describe, expect, it } from "vitest";
import {
  aggregateRoutesFromFlights,
} from "../route-aggregation";
import { statsFactsFromFlights } from "../flight-insights";
import { aggregateStatsSlice } from "../flight-statistics";
import {
  validateManualFlightRequest,
} from "../flights/service";
import type { Airport, Flight } from "../flight-data";
import { applyProposalCorrection } from "./corrections";
import { createLegacyRowFingerprint, createRowFingerprint } from "./fingerprint";
import {
  GENERIC_CSV_PRESETS,
  inspectGenericCsv,
  parseMappedGenericCsv,
  type GenericCsvMapping,
} from "./generic-csv";
import type {
  ImportAirportMatch,
  ProposedImportFlight,
  StoredImportRow,
} from "./types";
import { InMemoryImportRepository } from "./in-memory-repository";
import { stageMappedFlightImport } from "./worker";

const airportIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

const airports: Airport[] = ["AAA", "BBB", "CCC", "DDD"].map(
  (code, index) => ({
    code,
    name: code,
    city: code,
    country: "Test",
    lat: index * 5,
    lon: index * 10,
    facility: "general-aviation",
  }),
);

const mapping: GenericCsvMapping = {
  columns: {
    date: "Date",
    route: "Route",
    duration: "Duration",
  },
  dateFormat: "iso",
  durationFormat: "decimal-hours",
  defaults: { kind: "private", role: "pilot" },
};

describe("multi-stop flight contract", () => {
  it("uses MyFlightbook From/To as endpoints around ordered Route stops", () => {
    const preset = GENERIC_CSV_PRESETS.find(
      ({ id }) => id === "myflightbook-export",
    );
    if (!preset) throw new Error("Missing MyFlightbook preset");

    const content =
      "Date,Tail Number,Model,Total Flight Time,From,To,Route\n2026-08-14,N12345,C172,4.5,AAA,DDD,BBB CCC";
    const detected = inspectGenericCsv(content).preset;
    expect(detected?.id).toBe(preset.id);
    const parsed = parseMappedGenericCsv(content, detected!.suggestedMapping);

    expect(parsed.flights[0]).toMatchObject({
      originIdentifier: "AAA",
      destinationIdentifier: "DDD",
      airportIdentifiers: ["AAA", "BBB", "CCC", "DDD"],
      issues: [],
    });
  });

  it.each([
    ["AAA BBB CCC DDD", ["AAA", "BBB", "CCC", "DDD"]],
    ["AAA AAA BBB CCC DDD DDD", ["AAA", "BBB", "CCC", "DDD"]],
    ["BBB CCC", ["AAA", "BBB", "CCC", "AAA"]],
    ["AAA BBB CCC AAA", ["AAA", "BBB", "CCC", "AAA"]],
  ])(
    "does not duplicate explicit endpoints for Route=%s",
    (route, expected) => {
      const parsed = parseMappedGenericCsv(
        `Date,From,To,Route\n2026-08-14,AAA,${expected.at(-1)},${route}`,
        endpointMapping,
      );
      expect(parsed.flights[0]).toMatchObject({
        airportIdentifiers: expected,
        issues: [],
      });
    },
  );

  it("preserves directed repeated non-adjacent stops", () => {
    const parsed = parseMappedGenericCsv(
      "Date,From,To,Route\n2026-08-14,AAA,DDD,BBB AAA CCC BBB",
      endpointMapping,
    );
    expect(parsed.flights[0].airportIdentifiers).toEqual([
      "AAA",
      "BBB",
      "AAA",
      "CCC",
      "BBB",
      "DDD",
    ]);
  });

  it("keeps direct From/To imports on the simple v1 representation", () => {
    const parsed = parseMappedGenericCsv(
      "Date,From,To,Route\n2026-08-14,AAA,DDD,",
      endpointMapping,
    );
    expect(parsed.flights[0]).toMatchObject({
      originIdentifier: "AAA",
      destinationIdentifier: "DDD",
      issues: [],
    });
    expect(parsed.flights[0].airportIdentifiers).toBeUndefined();
  });

  it("parses an ordered closed-loop route without splitting the parent", () => {
    const parsed = parseMappedGenericCsv(
      'Date,Route,Duration\n2026-08-14,"AAA > BBB > CCC > DDD > AAA",4.5',
      mapping,
    );

    expect(parsed.flights).toHaveLength(1);
    expect(parsed.flights[0]).toMatchObject({
      originIdentifier: "AAA",
      destinationIdentifier: "AAA",
      airportIdentifiers: ["AAA", "BBB", "CCC", "DDD", "AAA"],
      durationHours: 4.5,
      issues: [],
    });
  });

  it("fingerprints the full directed sequence and adopts pre-v3 records", () => {
    const forward = proposal(["AAA", "BBB", "CCC", "DDD", "AAA"]);
    const reverse = proposal(["AAA", "DDD", "CCC", "BBB", "AAA"]);
    const repeated = proposal(["AAA", "BBB", "AAA", "BBB"]);
    const simple = proposal(["AAA", "BBB"]);

    expect(createRowFingerprint("user", forward)).not.toEqual(
      createRowFingerprint("user", reverse),
    );
    expect(createRowFingerprint("user", repeated)).not.toEqual(
      createRowFingerprint("user", simple),
    );
    // Every new fingerprint is v3. Compatibility with the v1 digests already
    // in the database is carried by the adoption chain rather than by
    // continuing to emit the old version, so a simple two-stop route still
    // recomputes byte-identically to its stored v1 value.
    expect(createRowFingerprint("user", simple)?.version).toBe(3);
    expect(createLegacyRowFingerprint("user", simple)?.version).toBe(1);
    expect(createLegacyRowFingerprint("user", simple)?.value).toBe(
      createLegacyRowFingerprint("user", proposal(["AAA", "BBB"]))?.value,
    );
  });

  it("projects every ordered leg while counting duration and parent once", () => {
    const flight: Flight = {
      id: "flight",
      date: "2026-08-14",
      origin: airports[0],
      destination: airports[0],
      airportSequence: [
        airports[0],
        airports[1],
        airports[2],
        airports[3],
        airports[0],
      ],
      kind: "private",
      role: "pilot",
      aircraft: "Test",
      durationHours: 4.5,
      distanceMiles: 500,
      source: "Manual",
    };

    const routes = aggregateRoutesFromFlights([flight]);
    expect(routes).toHaveLength(4);
    expect(routes.reduce((sum, route) => sum + route.flightCount, 0)).toBe(4);

    const facts = statsFactsFromFlights([flight]);
    const stats = aggregateStatsSlice(facts, {
      preset: "any",
      startDate: "2026-01-01",
      endDateExclusive: "2027-01-01",
      isPartial: false,
      elapsedDays: 365,
    });
    expect(stats.metrics.flights.value).toBe(1);
    expect(stats.metrics.durationHours.value).toBe(4.5);
    expect(stats.metrics.uniqueAirports.value).toBe(4);
    expect(stats.metrics.uniqueRoutes.value).toBe(4);
  });

  it("corrects one unresolved middle stop without clearing another", () => {
    const matches: ImportAirportMatch[] = [
      resolved(0),
      { status: "not-found", identifier: "XXX" },
      { status: "not-found", identifier: "YYY" },
      resolved(3),
    ];
    const row: StoredImportRow = {
      id: "row",
      batchId: "batch",
      rowNumber: 2,
      rawSnapshot: null,
      proposedFlight: {
        ...proposalBase(),
        origin: matches[0],
        destination: matches.at(-1),
        airportIdentifiers: ["AAA", "XXX", "YYY", "DDD"],
        airportMatches: matches,
      },
      issues: [
        routeIssue(1, "XXX"),
        routeIssue(2, "YYY"),
      ],
      validationState: "unresolved",
      commitReady: false,
      decision: "pending",
      provenance: {
        adapterId: "generic-csv-v1",
        adapterLabel: "Generic mapped CSV",
        adapterVersion: 1,
        source: "CSV",
        sourceRowNumber: 2,
      },
    };

    const corrected = applyProposalCorrection(
      row,
      {
        resolvedRouteStop: { index: 1, airport: resolved(1) },
      },
      "2026-08-14T00:00:00.000Z",
    );
    expect(corrected.proposedFlight.airportIdentifiers).toEqual([
      "AAA",
      "BBB",
      "YYY",
      "DDD",
    ]);
    expect(corrected.issues.map(({ field }) => field)).toEqual(["route[2]"]);
  });

  it("stages the exact unresolved middle stop and reimports idempotently", async () => {
    const repository = new InMemoryImportRepository(
      [0, 1, 3].map((index) => ({
        id: airportIds[index],
        airport: airports[index],
        aliases: [airports[index].code],
      })),
    );
    const content =
      'Date,Route,Duration\n2026-08-14,"AAA > BBB > CCC > DDD > AAA",4.5';
    const upload = {
      fileName: "route.csv",
      mimeType: "text/csv",
      sizeBytes: Buffer.byteLength(content),
      content,
    };
    const first = await stageMappedFlightImport(
      "user",
      upload,
      mapping,
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await repository.listRows("user", first.batchId, 1, 10);
    expect(detail?.rows[0]).toMatchObject({
      validationState: "unresolved",
      commitReady: false,
      issues: [
        expect.objectContaining({
          field: "route[2]",
          message: expect.stringContaining("CCC"),
        }),
      ],
    });

    const second = await stageMappedFlightImport(
      "user",
      upload,
      mapping,
      { imports: repository, flights: repository, airports: repository },
    );
    expect(second).toEqual({
      batchId: first.batchId,
      status: "review",
      reused: true,
    });
  });

  it.each([
    ["XXX", "not-found"],
    ["MID", "ambiguous"],
  ])(
    "stages a %s middle stop for review without losing endpoints",
    async (middle, status) => {
      const repository = new InMemoryImportRepository([
        {
          id: airportIds[0],
          airport: airports[0],
          aliases: ["AAA"],
        },
        {
          id: airportIds[1],
          airport: airports[1],
          aliases: ["MID", "B-ALIAS"],
        },
        {
          id: airportIds[2],
          airport: airports[2],
          aliases: ["MID"],
        },
        {
          id: airportIds[3],
          airport: airports[3],
          aliases: ["DDD"],
        },
      ]);
      const content =
        `Date,From,To,Route\n2026-08-14,AAA,DDD,${middle}`;
      const staged = await stageMappedFlightImport(
        "user",
        {
          fileName: `${middle}.csv`,
          mimeType: "text/csv",
          sizeBytes: Buffer.byteLength(content),
          content,
        },
        endpointMapping,
        { imports: repository, flights: repository, airports: repository },
      );
      const detail = await repository.listRows("user", staged.batchId, 1, 10);
      expect(detail?.rows[0]).toMatchObject({
        proposedFlight: {
          airportIdentifiers: ["AAA", middle, "DDD"],
          airportMatches: [
            { status: "resolved", identifier: "AAA" },
            { status, identifier: middle },
            { status: "resolved", identifier: "DDD" },
          ],
        },
        validationState: status === "ambiguous" ? "ambiguous" : "unresolved",
        commitReady: false,
        issues: [
          expect.objectContaining({
            field: "route[1]",
            message: expect.stringContaining(middle),
          }),
        ],
      });
    },
  );

  it("resolves a middle-stop alias while retaining the imported identifier", async () => {
    const repository = new InMemoryImportRepository(
      airports.map((airport, index) => ({
        id: airportIds[index],
        airport,
        aliases: index === 1 ? ["B-ALIAS"] : [airport.code],
      })),
    );
    const content =
      "Date,From,To,Route\n2026-08-14,AAA,DDD,B-ALIAS CCC";
    const staged = await stageMappedFlightImport(
      "user",
      {
        fileName: "alias.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(content),
        content,
      },
      endpointMapping,
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await repository.listRows("user", staged.batchId, 1, 10);
    expect(detail?.rows[0]).toMatchObject({
      proposedFlight: {
        airportIdentifiers: ["AAA", "B-ALIAS", "CCC", "DDD"],
        airportMatches: [
          { status: "resolved", identifier: "AAA" },
          { status: "resolved", identifier: "B-ALIAS", airportId: airportIds[1] },
          { status: "resolved", identifier: "CCC" },
          { status: "resolved", identifier: "DDD" },
        ],
      },
      validationState: "ready",
      commitReady: true,
      issues: [],
    });
  });

  it("accepts meaningful closed loops and rejects an empty A-to-A route", () => {
    expect(
      validateManualFlightRequest({
        classification: "personal",
        date: "2026-08-14",
        originAirportId: airportIds[0],
        intermediateAirportIds: [airportIds[1]],
        destinationAirportId: airportIds[0],
      }).intermediateAirportIds,
    ).toEqual([airportIds[1]]);
    expect(() =>
      validateManualFlightRequest({
        classification: "personal",
        date: "2026-08-14",
        originAirportId: airportIds[0],
        destinationAirportId: airportIds[0],
      }),
    ).toThrow(/meaningful leg/);
  });
});

const endpointMapping: GenericCsvMapping = {
  columns: {
    date: "Date",
    origin: "From",
    destination: "To",
    route: "Route",
  },
  dateFormat: "iso",
  defaults: { kind: "private", role: "pilot" },
};

function proposal(codes: string[]): ProposedImportFlight {
  const matches = codes.map((code) => resolved(airports.findIndex(
    (airport) => airport.code === code,
  )));
  return {
    ...proposalBase(),
    origin: matches[0],
    destination: matches.at(-1),
    originIdentifier: codes[0],
    destinationIdentifier: codes.at(-1),
    airportIdentifiers: codes,
    airportMatches: matches,
  };
}

function proposalBase(): ProposedImportFlight {
  return {
    date: "2026-08-14",
    departureTime: "08:00:00",
    kind: "private",
    role: "pilot",
    registration: "N12345",
    source: "CSV",
  };
}

function resolved(index: number): ImportAirportMatch {
  return {
    status: "resolved",
    identifier: airports[index].code,
    airportId: airportIds[index],
    airport: airports[index],
    matchedCodeTypes: ["icao"],
  };
}

function routeIssue(index: number, identifier: string) {
  return {
    code: "missing-airport" as const,
    field: `route[${index}]`,
    message: `Route stop ${index + 1} (${identifier}) could not be resolved`,
    severity: "warning" as const,
  };
}
