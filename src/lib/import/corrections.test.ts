import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { applyProposalCorrection, validateProposalPatch } from "./corrections";
import { isImportInvariantError } from "./errors";
import type { ImportAirportMatch, StoredImportRow } from "./types";

const airport: Airport = {
  code: "SEA",
  name: "Seattle-Tacoma International",
  city: "Seattle",
  country: "US",
  lat: 47,
  lon: -122,
  facility: "commercial",
};

function unresolvedRow(): StoredImportRow {
  return {
    id: "row-a",
    batchId: "batch-a",
    rowNumber: 2,
    rawSnapshot: ["KXXX", "KJFK", "private source note"],
    proposedFlight: {
      date: "2026-08-01",
      originIdentifier: "KXXX",
      origin: { status: "not-found", identifier: "KXXX" },
      destinationIdentifier: "KJFK",
      destination: { status: "not-found", identifier: "KJFK" },
      kind: "commercial",
      role: "passenger",
      source: "FlightRadar24",
    },
    issues: [
      {
        code: "invalid-airport-identifier",
        field: "From",
        message: "Unknown origin",
        severity: "error",
      },
    ],
    validationState: "unresolved",
    commitReady: false,
    decision: "pending",
    provenance: {
      adapterId: "test",
      adapterLabel: "Test",
      adapterVersion: 1,
      source: "FlightRadar24",
      sourceRowNumber: 2,
    },
  };
}

describe("staged corrections", () => {
  it("preserves raw source truth while auditing canonical airport selection", () => {
    const source = unresolvedRow();
    const corrected = applyProposalCorrection(
      source,
      {
        origin: {
          status: "resolved",
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
          matchedCodeTypes: ["icao"],
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    expect(corrected.rawSnapshot).toEqual(source.rawSnapshot);
    expect(corrected.proposedFlight.origin).toMatchObject({
      status: "resolved",
      airportId: "airport-sea",
    });
    expect(corrected.issues).toEqual([]);
    expect(corrected.corrections).toHaveLength(1);
    expect(corrected.corrections?.[0]).toMatchObject({
      field: "origin",
      originalValue: { status: "not-found", identifier: "KXXX" },
    });
  });

  it("is idempotent for a repeated identical correction", () => {
    const first = applyProposalCorrection(
      unresolvedRow(),
      {
        origin: {
          status: "resolved",
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
          matchedCodeTypes: ["icao"],
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    const second = applyProposalCorrection(
      first,
      { origin: first.proposedFlight.origin },
      "2026-08-12T19:00:00.000Z",
    );
    expect(second.corrections).toEqual(first.corrections);
  });

  it("supports explicitly clearing optional flight metadata", () => {
    const source = unresolvedRow();
    source.proposedFlight.flightNumber = "AS100";
    const patch = validateProposalPatch({ flightNumber: "" });
    const corrected = applyProposalCorrection(
      source,
      patch,
      "2026-08-12T18:00:00.000Z",
    );
    expect(corrected.proposedFlight.flightNumber).toBeUndefined();
    expect(corrected.corrections?.[0]).toMatchObject({
      field: "flightNumber",
      originalValue: "AS100",
      correctedValue: undefined,
    });
  });

  it("rejects malformed dates, times, and unexpected fields", () => {
    expect(() => validateProposalPatch({ date: "2026-02-31" })).toThrow(
      /valid YYYY-MM-DD/,
    );
    expect(() =>
      validateProposalPatch({ departureTime: "25:00" }),
    ).toThrow(/HH:MM/);
    expect(() =>
      validateProposalPatch({ unsafe: "value" } as never),
    ).toThrow(/unsupported/);
  });

  // Regression: correcting an airport used to patch only the derived
  // origin/destination/airportMatches projection and leave routeNodes stale.
  // Every commit-readiness check, the committed stop list, and the row
  // fingerprint read the nodes, so the corrected row committed its *original*
  // airport and stopped matching its own identity.
  it("corrects the canonical route nodes, not just the derived projection", () => {
    const source = unresolvedRow();
    const waypoint: ImportAirportMatch = {
      status: "resolved",
      identifier: "KRBG",
      airportId: "airport-rbg",
      airport: { ...airport, code: "RBG", name: "Roseburg Regional" },
      matchedCodeTypes: ["icao"],
    };
    source.proposedFlight.routeNodes = [
      {
        kind: "landing",
        identifier: "KXXX",
        match: { status: "not-found", identifier: "KXXX" },
        sourceField: "From",
        tokenIndex: 0,
      },
      {
        kind: "waypoint",
        identifier: "KRBG",
        match: waypoint,
        sourceField: "Route",
        tokenIndex: 1,
      },
      {
        kind: "landing",
        identifier: "KJFK",
        match: { status: "not-found", identifier: "KJFK" },
        sourceField: "To",
        tokenIndex: 2,
      },
    ];

    const corrected = applyProposalCorrection(
      source,
      {
        origin: {
          status: "resolved",
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
          matchedCodeTypes: ["icao"],
        },
      },
      "2026-08-12T18:00:00.000Z",
    );

    const nodes = corrected.proposedFlight.routeNodes ?? [];
    expect(nodes[0]).toMatchObject({
      kind: "landing",
      identifier: "KSEA",
      match: { status: "resolved", airportId: "airport-sea" },
    });
    // The waypoint is untouched — a landing correction never reclassifies it.
    expect(nodes[1]).toMatchObject({ kind: "waypoint", identifier: "KRBG" });
    // The derived projection stays landings-only and agrees with the nodes.
    expect(corrected.proposedFlight.airportMatches).toHaveLength(2);
    expect(corrected.proposedFlight.origin).toMatchObject({
      airportId: "airport-sea",
    });
    expect(corrected.proposedFlight.airportIdentifiers).toEqual([
      "KSEA",
      "KJFK",
    ]);
  });

  it("addresses a route-stop correction by landing index, skipping waypoints", () => {
    const source = unresolvedRow();
    source.proposedFlight.routeNodes = [
      {
        kind: "landing",
        identifier: "KXXX",
        match: { status: "not-found", identifier: "KXXX" },
        sourceField: "From",
        tokenIndex: 0,
      },
      {
        kind: "waypoint",
        identifier: "KRBG",
        match: {
          status: "resolved",
          identifier: "KRBG",
          airportId: "airport-rbg",
          airport: { ...airport, code: "RBG", name: "Roseburg Regional" },
          matchedCodeTypes: ["icao"],
        },
        sourceField: "Route",
        tokenIndex: 1,
      },
      {
        kind: "landing",
        identifier: "KJFK",
        match: { status: "not-found", identifier: "KJFK" },
        sourceField: "To",
        tokenIndex: 2,
      },
    ];
    source.proposedFlight.airportMatches = [
      source.proposedFlight.origin!,
      source.proposedFlight.destination!,
    ];

    const corrected = applyProposalCorrection(
      source,
      {
        resolvedRouteStop: {
          index: 1,
          airport: {
            status: "resolved",
            identifier: "KSEA",
            airportId: "airport-sea",
            airport,
            matchedCodeTypes: ["icao"],
          },
        },
      },
      "2026-08-12T18:00:00.000Z",
    );

    const nodes = corrected.proposedFlight.routeNodes ?? [];
    expect(nodes[1]).toMatchObject({ kind: "waypoint", identifier: "KRBG" });
    expect(nodes[2]).toMatchObject({
      kind: "landing",
      identifier: "KSEA",
      match: { airportId: "airport-sea" },
    });
    expect(corrected.proposedFlight.destination).toMatchObject({
      airportId: "airport-sea",
    });
  });

  describe("route stop bounds", () => {
    // The index arrives from a request body. It is bounded here, before it
    // addresses anything, and it is bounded on *both* sides: a negative index
    // reaching the node correction counts from the end, so `-1` would silently
    // rewrite the destination the caller never asked about. And the failure is
    // a typed 422 rather than a bare `Error`, which the API catch-all reported
    // as 503 — "retry later" for a condition that will never resolve.
    const routedRow = (): StoredImportRow => {
      const source = unresolvedRow();
      source.proposedFlight.routeNodes = [
        {
          kind: "landing",
          identifier: "KXXX",
          match: { status: "not-found", identifier: "KXXX" },
          sourceField: "From",
          tokenIndex: 0,
        },
        {
          kind: "waypoint",
          identifier: "KRBG",
          match: {
            status: "resolved",
            identifier: "KRBG",
            airportId: "airport-rbg",
            airport: { ...airport, code: "RBG", name: "Roseburg Regional" },
            matchedCodeTypes: ["icao"],
          },
          sourceField: "Route",
          tokenIndex: 1,
        },
        {
          kind: "landing",
          identifier: "KJFK",
          match: { status: "not-found", identifier: "KJFK" },
          sourceField: "To",
          tokenIndex: 2,
        },
      ];
      source.proposedFlight.airportMatches = [
        source.proposedFlight.origin!,
        source.proposedFlight.destination!,
      ];
      return source;
    };

    const correction = (index: number) => ({
      resolvedRouteStop: {
        index,
        airport: {
          status: "resolved" as const,
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
          matchedCodeTypes: ["icao" as const],
        },
      },
    });

    it.each([
      ["above the landing count", 2],
      ["far above the landing count", 99],
      ["negative", -1],
      ["not an integer", 0.5],
    ])("refuses an index %s with a typed 422 invariant", (_label, index) => {
      // 2 is the count of *landings*, not of nodes: the row has three nodes
      // and the waypoint is not addressable.
      let thrown: unknown;
      try {
        applyProposalCorrection(
          routedRow(),
          correction(index),
          "2026-08-12T18:00:00.000Z",
        );
      } catch (error) {
        thrown = error;
      }
      expect(isImportInvariantError(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        code: "route-stop-invalid",
        status: 422,
      });
    });

    it("still refuses an out-of-range index on a legacy row with no nodes", () => {
      const legacy = unresolvedRow();
      legacy.proposedFlight.airportMatches = [
        legacy.proposedFlight.origin!,
        legacy.proposedFlight.destination!,
      ];
      expect(() =>
        applyProposalCorrection(
          legacy,
          correction(2),
          "2026-08-12T18:00:00.000Z",
        ),
      ).toThrow(/out of range/);
      expect(() =>
        applyProposalCorrection(
          legacy,
          correction(-1),
          "2026-08-12T18:00:00.000Z",
        ),
      ).toThrow(/out of range/);
    });

    it("leaves the row untouched when the index is refused", () => {
      // The throw happens before any correction is recorded, so a rejected
      // request cannot half-apply.
      const source = routedRow();
      const before = structuredClone(source);
      expect(() =>
        applyProposalCorrection(
          source,
          correction(5),
          "2026-08-12T18:00:00.000Z",
        ),
      ).toThrow();
      expect(source).toEqual(before);
    });
  });
});
