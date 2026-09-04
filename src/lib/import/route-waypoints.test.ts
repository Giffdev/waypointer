import { describe, expect, it } from "vitest";
import { aggregateStatsSlice, type StatsPeriod } from "../flight-statistics";
import { statsFactsFromFlights } from "../flight-insights";
import type { Airport, Flight } from "../flight-data";
import { flightAirportSequence, flightRoutePath } from "../flight-data";
import { createFlightRoutePathFeatureCollection } from "../map-geojson";
import { assertCommittableRoute, MAX_ROUTE_PATH_NODES } from "./invariants";
import { hasUnresolvedRouteToken } from "./attention";
import { isImportInvariantError } from "./errors";
import {
  isAirportNamespaceMatch,
  landingCountNote,
  normalizeFlightRoute,
  rejectRouteTokenShape,
  tokenizeRoute,
} from "./route-normalization";
import type {
  AirportIdentifierType,
  ImportAirportMatch,
  ProposedImportFlight,
} from "./types";

/**
 * Route waypoint durability.
 *
 * The rule these tests exist to defend: **a route airport is a waypoint, never
 * an inferred landing.** Two questions, two mechanisms. "Is this an airport?"
 * is answered by the classifier. "Did the pilot land there?" is answered only
 * by an explicit source endpoint field or a deliberate user action. If a
 * future change lets the classifier answer the second question, the
 * statistics-isolation tests below fail.
 */

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Example",
  country: "US",
  lat: 42 + code.length / 10,
  lon: -123 - code.length / 10,
  facility: "general-aviation",
});

const resolved = (
  identifier: string,
  ...matchedCodeTypes: AirportIdentifierType[]
): ImportAirportMatch => ({
  status: "resolved",
  identifier,
  airportId: `airport-${identifier.toLowerCase()}`,
  airport: airport(identifier),
  ...(matchedCodeTypes.length
    ? { matchedCodeTypes }
    : { matchedCodeTypes: ["icao" as const] }),
});

const notFound = (identifier: string): ImportAirportMatch => ({
  status: "not-found",
  identifier,
});

const catalog = (
  entries: Record<string, ImportAirportMatch>,
) => (identifier: string) => entries[identifier] ?? notFound(identifier);

const endpoints = (from: string, to: string, entries: Record<string, ImportAirportMatch>) => ({
  origin: { identifier: from, match: entries[from], field: "From" as const },
  destination: { identifier: to, match: entries[to], field: "To" as const },
});

describe("route tokenizer", () => {
  it("splits every separator a logbook actually writes", () => {
    expect(tokenizeRoute("KMFR KRBG KEUG")).toEqual(["KMFR", "KRBG", "KEUG"]);
    expect(tokenizeRoute("kmfr->krbg→keug")).toEqual([
      "KMFR",
      "KRBG",
      "KEUG",
    ]);
    expect(tokenizeRoute("KMFR > KRBG, KEUG; S39 | 4S1 / KPDX")).toEqual([
      "KMFR",
      "KRBG",
      "KEUG",
      "S39",
      "4S1",
      "KPDX",
    ]);
    expect(tokenizeRoute("   ")).toEqual([]);
    expect(tokenizeRoute(undefined)).toEqual([]);
  });

  it("rejects nav fixes and procedures on shape, before any catalog lookup", () => {
    // Shape rejection runs first precisely so a five-letter RNAV fix cannot
    // get a lucky catalog hit and be drawn as an airport.
    for (const token of ["ITIDE", "OBSHY", "HAWKZ"]) {
      expect(rejectRouteTokenShape(token)).toBe("nav-fix-shape");
    }
    for (const token of ["V23", "J501", "Q1", "T257"]) {
      expect(rejectRouteTokenShape(token)).toBe("airway-or-procedure");
    }
    expect(rejectRouteTokenShape("MODOC.J501")).toBe("airway-or-procedure");
    expect(rejectRouteTokenShape("DCT")).toBe("structural-token");
    expect(rejectRouteTokenShape("VFR")).toBe("structural-token");
    expect(rejectRouteTokenShape("OED123456")).toBe("nav-fix-shape");
    expect(rejectRouteTokenShape("4530N12230W")).toBe("nav-fix-shape");
    expect(rejectRouteTokenShape("K")).toBe("nav-fix-shape");

    // Real airport identifiers in every namespace survive shape rejection.
    for (const token of ["KMFR", "KRBG", "S39", "4S1", "OMK", "W01"]) {
      expect(rejectRouteTokenShape(token)).toBeUndefined();
    }
  });
});

describe("airport namespace guard", () => {
  it("accepts airport namespaces and refuses IATA-only navaid collisions", () => {
    expect(isAirportNamespaceMatch(resolved("KRBG", "icao"))).toBe(true);
    expect(isAirportNamespaceMatch(resolved("S39", "faa-lid"))).toBe(true);
    expect(isAirportNamespaceMatch(resolved("W01", "gps"))).toBe(true);
    expect(isAirportNamespaceMatch(resolved("OMK", "ident"))).toBe(true);
    // OED is the Medford VOR as well as an IATA code. An IATA-only hit is not
    // evidence that the pilot's route string meant the airport.
    expect(isAirportNamespaceMatch(resolved("OED", "iata"))).toBe(false);
    expect(isAirportNamespaceMatch(resolved("SEA", "local"))).toBe(false);
    expect(isAirportNamespaceMatch(notFound("ITIDE"))).toBe(false);
  });

  it("judges the whole alias-type set, not the priority winner", () => {
    // BFI is Boeing Field's IATA code *and* its FAA-LID. Alias priority ranks
    // IATA above FAA-LID, so a guard that inspected only the winning row saw
    // ["iata"] and rejected a real airport. The resolver reports every type
    // the code maps to for the winning airport, and any airport-namespace
    // member is enough.
    expect(isAirportNamespaceMatch(resolved("BFI", "iata", "faa-lid"))).toBe(
      true,
    );
    // Order must not matter.
    expect(isAirportNamespaceMatch(resolved("BFI", "faa-lid", "iata"))).toBe(
      true,
    );
    // A code with only non-airport namespaces is still refused, however many
    // of them there are.
    expect(isAirportNamespaceMatch(resolved("OED", "iata", "local"))).toBe(
      false,
    );
  });

  it("treats a match with no recorded code type as an airport", () => {
    // Rows persisted before the guard shipped carry no code type; they must
    // keep rendering exactly as they did.
    const legacy: ImportAirportMatch = {
      status: "resolved",
      identifier: "KRBG",
      airportId: "airport-krbg",
      airport: airport("KRBG"),
    };
    expect(isAirportNamespaceMatch(legacy)).toBe(true);
    expect(
      isAirportNamespaceMatch({ ...legacy, matchedCodeTypes: [] }),
    ).toBe(true);
  });
});

describe("normalizeFlightRoute", () => {
  it("builds Roseburg as a waypoint and leaves the endpoints as landings", async () => {
    const entries = {
      KMFR: resolved("KMFR"),
      KRBG: resolved("KRBG"),
      KEUG: resolved("KEUG"),
    };
    const route = await normalizeFlightRoute({
      routeRaw: "KMFR KRBG KEUG",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });

    expect(route.nodes.map((node) => [node.identifier, node.kind])).toEqual([
      ["KMFR", "landing"],
      ["KMFR", "unmatched"],
      ["KRBG", "waypoint"],
      ["KEUG", "unmatched"],
      ["KEUG", "landing"],
    ]);
    expect(route.issues).toEqual([]);
    expect(route.routeRaw).toBe("KMFR KRBG KEUG");
  });

  it("never promotes a route token to a landing, whatever the token looks like", async () => {
    const entries = {
      KMFR: resolved("KMFR"),
      KRBG: resolved("KRBG"),
      KEUG: resolved("KEUG"),
      S39: resolved("S39", "faa-lid"),
    };
    const route = await normalizeFlightRoute({
      routeRaw: "KRBG S39",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });
    const landings = route.nodes.filter((node) => node.kind === "landing");
    expect(landings.map((node) => node.identifier)).toEqual(["KMFR", "KEUG"]);
    expect(
      landings.every(
        (node) => node.sourceField === "From" || node.sourceField === "To",
      ),
    ).toBe(true);
  });

  it("warns visibly when a token is rejected as a navaid or IATA collision", async () => {
    // Rejecting silently is indistinguishable, from the user's side, from the
    // classifier never having seen the token — and this rejection is the one
    // most likely to be wrong, because the token *did* resolve to an airport.
    const entries = {
      KMFR: resolved("KMFR"),
      KEUG: resolved("KEUG"),
      OED: resolved("OED", "iata"),
    };
    const route = await normalizeFlightRoute({
      routeRaw: "OED",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });

    expect(route.nodes.some((node) => node.kind === "waypoint")).toBe(false);
    expect(route.rejections).toEqual([
      { identifier: "OED", tokenIndex: 0, reason: "navaid-or-iata-collision" },
    ]);
    expect(route.issues).toEqual([
      {
        code: "route-token-navaid-collision",
        field: "route[0]",
        message: expect.stringContaining("OED"),
        severity: "warning",
      },
    ]);
    // Counted as outstanding work, so the badge cannot say "nothing to do".
    expect(hasUnresolvedRouteToken(route.issues)).toBe(true);
  });

  it("accepts a token whose airport-namespace alias is not the priority winner", async () => {
    const entries = {
      KMFR: resolved("KMFR"),
      KEUG: resolved("KEUG"),
      BFI: resolved("BFI", "iata", "faa-lid"),
    };
    const route = await normalizeFlightRoute({
      routeRaw: "BFI",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });
    expect(
      route.nodes
        .filter((node) => node.kind === "waypoint")
        .map((node) => node.identifier),
    ).toEqual(["BFI"]);
    expect(route.issues).toEqual([]);
  });

  it("keeps unresolved and nav tokens in place as warnings, not errors", async () => {
    const entries = { KMFR: resolved("KMFR"), KEUG: resolved("KEUG") };
    const route = await normalizeFlightRoute({
      routeRaw: "KMFR ITIDE ZZZZ V23 KEUG",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });

    expect(
      route.nodes.filter((node) => node.kind === "waypoint"),
    ).toHaveLength(0);
    expect(
      route.rejections.map(({ identifier, reason }) => [identifier, reason]),
    ).toEqual([
      ["ITIDE", "nav-fix-shape"],
      ["ZZZZ", "not-found"],
      ["V23", "airway-or-procedure"],
    ]);
    // Warnings, never errors: an unrecognised route point must not stop a
    // flight the pilot actually flew from being imported.
    expect(route.issues.every((issue) => issue.severity === "warning")).toBe(
      true,
    );
    expect(route.issues.map((issue) => issue.code)).toEqual([
      "route-token-unmatched",
    ]);
    // The verbatim text survives, so nothing is lost even when nothing places.
    expect(route.routeRaw).toBe("KMFR ITIDE ZZZZ V23 KEUG");
  });

  it("warns instead of resolving when a route token is ambiguous", async () => {
    const entries = {
      KMFR: resolved("KMFR"),
      KEUG: resolved("KEUG"),
      SPR: {
        status: "ambiguous" as const,
        identifier: "SPR",
        candidates: [
          { airportId: "a", code: "SPR", name: "Synthetic SPR A" },
          { airportId: "b", code: "SPR", name: "Synthetic SPR B" },
        ],
      },
    };
    const route = await normalizeFlightRoute({
      routeRaw: "SPR",
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });
    expect(route.issues[0]).toMatchObject({
      code: "route-token-ambiguous",
      severity: "warning",
    });
    expect(route.nodes.some((node) => node.kind === "waypoint")).toBe(false);
  });

  it("dedupes endpoints and adjacent repeats but preserves an out-and-back", async () => {
    const entries = {
      KMFR: resolved("KMFR"),
      KRBG: resolved("KRBG"),
    };
    const route = await normalizeFlightRoute({
      routeRaw: "KMFR KRBG KRBG KMFR KRBG KMFR",
      ...endpoints("KMFR", "KMFR", entries),
      resolve: catalog(entries),
    });
    const path = route.nodes
      .filter((node) => node.kind !== "unmatched")
      .map((node) => node.identifier);
    // Leading/trailing endpoint repeats collapse into the endpoints; the
    // adjacent KRBG KRBG collapses; the genuine non-adjacent KMFR in the
    // middle survives, because flying out and back is a real thing to do.
    expect(path).toEqual(["KMFR", "KRBG", "KMFR", "KRBG", "KMFR"]);
    expect(
      route.rejections.filter((r) => r.reason === "adjacent-duplicate").length,
    ).toBeGreaterThan(0);
  });

  it("caps the path and warns rather than invalidating the row", async () => {
    const identifiers = Array.from({ length: 40 }, (_, index) =>
      `K${String(index).padStart(3, "0")}`,
    );
    const entries: Record<string, ImportAirportMatch> = {
      KMFR: resolved("KMFR"),
      KEUG: resolved("KEUG"),
    };
    for (const identifier of identifiers) {
      entries[identifier] = resolved(identifier);
    }
    const route = await normalizeFlightRoute({
      routeRaw: identifiers.join(" "),
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });

    const placed = route.nodes.filter((node) => node.kind !== "unmatched");
    expect(placed).toHaveLength(MAX_ROUTE_PATH_NODES);
    expect(
      route.rejections.filter((r) => r.reason === "route-too-long"),
    ).toHaveLength(40 - (MAX_ROUTE_PATH_NODES - 2));
    expect(route.issues.every((issue) => issue.severity === "warning")).toBe(
      true,
    );
  });

  it("degrades silently when the source has no route column", async () => {
    const entries = { KMFR: resolved("KMFR"), KEUG: resolved("KEUG") };
    const route = await normalizeFlightRoute({
      ...endpoints("KMFR", "KEUG", entries),
      resolve: catalog(entries),
    });
    expect(route.nodes.map((node) => node.kind)).toEqual([
      "landing",
      "landing",
    ]);
    expect(route.issues).toEqual([]);
    expect(route.routeRaw).toBeUndefined();
  });
});

describe("landing count columns", () => {
  it("notes a shortfall without adding a stop or raising an error", () => {
    expect(landingCountNote({ all: 4 }, 2)).toMatchObject({
      severity: "warning",
      code: "route-landing-count-mismatch",
    });
    expect(landingCountNote({ all: 2 }, 2)).toBeUndefined();
    expect(landingCountNote(undefined, 2)).toBeUndefined();
    expect(landingCountNote({}, 2)).toBeUndefined();
  });
});

describe("commit invariants", () => {
  const flightWith = (
    nodes: ProposedImportFlight["routeNodes"],
  ): ProposedImportFlight => ({
    date: "2026-05-01",
    kind: "private",
    role: "pilot",
    source: "ForeFlight",
    routeNodes: nodes,
  });

  it("returns landings and waypoints separately for a committable route", () => {
    const committable = assertCommittableRoute(
      flightWith([
        { kind: "landing", identifier: "KMFR", match: resolved("KMFR"), sourceField: "From" },
        { kind: "waypoint", identifier: "KRBG", match: resolved("KRBG"), sourceField: "Route", tokenIndex: 0 },
        { kind: "landing", identifier: "KEUG", match: resolved("KEUG"), sourceField: "To" },
      ]),
    );
    expect(committable.landingIds).toEqual(["airport-kmfr", "airport-keug"]);
    expect(committable.waypointIds).toEqual(["airport-krbg"]);
    expect(committable.pathNodes).toHaveLength(3);
  });

  it("throws a typed invariant error instead of silently dropping a leg", () => {
    // The predecessor flat-mapped unresolved matches away and checked only
    // `length >= 2`, so a flight could commit with a middle stop missing.
    try {
      assertCommittableRoute(
        flightWith([
          { kind: "landing", identifier: "KMFR", match: resolved("KMFR"), sourceField: "From" },
          { kind: "landing", identifier: "ZZZZ", match: notFound("ZZZZ"), sourceField: "endpoint" },
          { kind: "landing", identifier: "KEUG", match: resolved("KEUG"), sourceField: "To" },
        ]),
      );
      expect.unreachable("an unresolved landing must not commit");
    } catch (error) {
      expect(isImportInvariantError(error)).toBe(true);
      if (isImportInvariantError(error)) {
        expect(error.code).toBe("route-stop-unresolved");
      }
    }
  });

  it("refuses a path longer than the cap", () => {
    const nodes: NonNullable<ProposedImportFlight["routeNodes"]> = [
      { kind: "landing", identifier: "KMFR", match: resolved("KMFR"), sourceField: "From" },
      ...Array.from({ length: MAX_ROUTE_PATH_NODES }, (_, index) => ({
        kind: "waypoint" as const,
        identifier: `K${index}`,
        match: resolved(`K${index}`),
        sourceField: "Route" as const,
        tokenIndex: index,
      })),
      { kind: "landing", identifier: "KEUG", match: resolved("KEUG"), sourceField: "To" },
    ];
    expect(() => assertCommittableRoute(flightWith(nodes))).toThrow(
      /at most 32 airports/,
    );
  });
});

describe("statistics isolation", () => {
  const withRoute = (routePath: Flight["routePath"]): Flight => ({
    id: "flight-1",
    date: "2026-05-01",
    origin: airport("KMFR"),
    destination: airport("KEUG"),
    airportSequence: [airport("KMFR"), airport("KEUG")],
    kind: "private",
    role: "pilot",
    aircraft: "C172",
    distanceMiles: 120,
    source: "ForeFlight",
    ...(routePath ? { routePath } : {}),
  });

  const withoutWaypoint = withRoute(undefined);
  const withWaypoint = withRoute([
    { airport: airport("KMFR"), kind: "landing" },
    { airport: airport("KRBG"), kind: "waypoint" },
    { airport: airport("KEUG"), kind: "landing" },
  ]);

  it("produces byte-identical statistics with and without a route waypoint", () => {
    // This is the whole promise of the waypoint model: drawing an overflight
    // on the map cannot change a single number on the stats page.
    const period: StatsPeriod = {
      preset: "custom",
      startDate: "2026-01-01",
      endDateExclusive: "2027-01-01",
      isPartial: false,
      elapsedDays: 365,
    };
    const withFacts = statsFactsFromFlights([withWaypoint]);
    const withoutFacts = statsFactsFromFlights([withoutWaypoint]);
    expect(withFacts).toEqual(withoutFacts);
    expect(aggregateStatsSlice(withFacts, period)).toEqual(
      aggregateStatsSlice(withoutFacts, period),
    );
    expect(
      aggregateStatsSlice(withFacts, period).metrics.uniqueAirports.value,
    ).toBe(2);
  });

  it("keeps the landing sequence landings-only while the path shows the waypoint", () => {
    expect(flightAirportSequence(withWaypoint).map(({ code }) => code)).toEqual(
      ["KMFR", "KEUG"],
    );
    expect(
      flightRoutePath(withWaypoint).map((node) => [node.airport.code, node.kind]),
    ).toEqual([
      ["KMFR", "landing"],
      ["KRBG", "waypoint"],
      ["KEUG", "landing"],
    ]);
  });

  it("falls back to the landing sequence when a flight has no route", () => {
    expect(
      flightRoutePath(withoutWaypoint).map((node) => [
        node.airport.code,
        node.kind,
      ]),
    ).toEqual([
      ["KMFR", "landing"],
      ["KEUG", "landing"],
    ]);
  });

  it("draws the waypoint in the map route-path layer", () => {
    const collection = createFlightRoutePathFeatureCollection([withWaypoint]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].properties).toMatchObject({
      flightId: "flight-1",
      pathCodes: ["KMFR", "KRBG", "KEUG"],
      waypointCodes: ["KRBG"],
      landingCodes: ["KMFR", "KEUG"],
      hasWaypoints: true,
    });
    // One drawn segment per leg, so the line bends through the waypoint
    // rather than flying straight past it.
    expect(collection.features[0].geometry.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it("marks a waypointless flight as such so the layer can be skipped", () => {
    const collection = createFlightRoutePathFeatureCollection([withoutWaypoint]);
    expect(collection.features[0].properties.hasWaypoints).toBe(false);
    expect(collection.features[0].properties.waypointCodes).toEqual([]);
  });
});
