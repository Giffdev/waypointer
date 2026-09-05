import { describe, expect, it } from "vitest";
import {
  parsePublicMapProjection,
  parsePublicMapProjectionV4,
  PublicMapProjectionValidationError,
} from "./client-projection";
import {
  DEFAULT_PUBLIC_MAP_FILTERS,
  derivePublicMapSlice,
} from "./public-map-filtering";
import {
  rollbackCompatibleStoredProjection,
  toLegacyPublicMapProjection,
  toV3PublicMapProjection,
  type PublicMapProjection,
} from "./service";
import { toSharedMapData } from "@/components/shared-map-view";
import {
  createFlightRoutePathFeatureCollection,
  createRouteWaypointFeatureCollection,
} from "@/lib/map-geojson";
import type { Flight } from "@/lib/flight-data";

/**
 * Public route-waypoint parity.
 *
 * A shared map should look like the map its owner sees. What it must *not*
 * do is start counting the same things differently: a waypoint is drawn in
 * both places and visited in neither, so every landing-shaped number in the
 * public projection has to be identical whether or not a flight overflew
 * somewhere.
 */

const airport = (
  code: string,
  name: string,
  city: string,
  country: string,
  lat: number,
  lon: number,
) => ({
  code,
  name,
  city,
  country,
  lat,
  lon,
  facility: "general-aviation" as const,
});

const S05 = airport("S05", "Bandon State", "Bandon", "US", 43.0, -124.4);
const KRBG = airport("KRBG", "Roseburg Regional", "Roseburg", "US", 43.2, -123.3);

/** The out-and-back: departs and lands at S05, overflying KRBG. */
const outAndBackRoute: PublicMapProjection["routes"][number] = {
  id: "s05-s05-private",
  kind: "private",
  flightCount: 1,
  forwardFlightCount: 0,
  reverseFlightCount: 0,
  directionMode: "none",
  origin: S05,
  destination: S05,
};

function projection(
  withWaypoints: boolean,
): PublicMapProjection {
  return {
    schemaVersion: 4,
    owner: { displayName: "Devin" },
    summary: { flightCount: 1, routeCount: 1 },
    routes: [outAndBackRoute],
    flights: [
      {
        date: "2026-05-01",
        kind: "private",
        role: "pilot",
        aircraft: ["C172"],
        registration: "N12345",
        ...(withWaypoints
          ? {
              routePath: [
                { airport: S05, kind: "landing" as const },
                { airport: KRBG, kind: "waypoint" as const },
                { airport: S05, kind: "landing" as const },
              ],
            }
          : {}),
        routeLegs: [{ routeId: outAndBackRoute.id, direction: "none" as const }],
      },
    ],
  };
}

describe("public share projection carries the ordered path", () => {
  it("round-trips an ordered routePath through the contract=4 client parser", () => {
    const parsed = parsePublicMapProjectionV4(
      JSON.parse(JSON.stringify(projection(true))),
    );
    expect(
      parsed.flights[0].routePath?.map((node) => [node.airport.code, node.kind]),
    ).toEqual([
      ["S05", "landing"],
      ["KRBG", "waypoint"],
      ["S05", "landing"],
    ]);
  });

  it("downgrades a freshly republished waypoint snapshot to the frozen contract=3 shape, which the previous-generation parser still accepts", () => {
    // The pre-waypoint parser (`parsePublicMapProjection`) is exactly what
    // every already-shipped browser bundle runs. A freshly republished
    // waypoint snapshot must still parse under it once downgraded to
    // contract=3 — the whole point of freezing that contract.
    const v3 = toV3PublicMapProjection(projection(true));
    const parsed = parsePublicMapProjection(JSON.parse(JSON.stringify(v3)));
    expect(parsed.flights[0]).not.toHaveProperty("routePath");
    expect(Object.keys(parsed.flights[0]).toSorted()).toEqual(
      [
        "date",
        "kind",
        "role",
        "aircraft",
        "registration",
        "routeLegs",
      ].toSorted(),
    );
    expect(parsed.summary).toEqual({ flightCount: 1, routeCount: 1 });
  });

  it("never errors a stale contract=3 poller, waypoints or not", () => {
    // A browser tab left open across a republish keeps polling contract=3.
    // Whether or not the underlying snapshot now carries waypoints, that
    // poll must never throw.
    for (const withWaypoints of [false, true]) {
      const v3 = toV3PublicMapProjection(projection(withWaypoints));
      expect(() =>
        parsePublicMapProjection(JSON.parse(JSON.stringify(v3))),
      ).not.toThrow();
    }
  });

  it.each([
    [
      "a path that starts on a waypoint",
      [
        { airport: KRBG, kind: "waypoint" },
        { airport: S05, kind: "landing" },
      ],
    ],
    [
      "a path with no waypoint at all",
      [
        { airport: S05, kind: "landing" },
        { airport: S05, kind: "landing" },
      ],
    ],
    ["a path with a single node", [{ airport: S05, kind: "landing" }]],
    [
      "a node carrying an unexpected field",
      [
        { airport: S05, kind: "landing", routeRaw: "S05 KRBG S05" },
        { airport: KRBG, kind: "waypoint" },
        { airport: S05, kind: "landing" },
      ],
    ],
  ])("rejects %s", (_label, routePath) => {
    const invalid = projection(true);
    // A public map is drawn from this. A malformed path must fail loudly
    // rather than render a straight line and never say why.
    (invalid.flights[0] as { routePath: unknown }).routePath = routePath;
    expect(() =>
      parsePublicMapProjectionV4(JSON.parse(JSON.stringify(invalid))),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("keeps the ordered path out of the schema-2 rollback contract", () => {
    // A schema-2 response is served to already-shipped browsers whose parser
    // rejects an unrecognised key outright.
    const legacy = toLegacyPublicMapProjection(projection(true));
    expect(legacy.flights[0]).not.toHaveProperty("routePath");
    expect(Object.keys(legacy.flights[0]).toSorted()).toEqual([
      "aircraft",
      "date",
      "kind",
      "registration",
      "role",
      "routeIds",
    ]);
  });

  it("stores the ordered path where a rolled-back build simply ignores it", () => {
    const stored = rollbackCompatibleStoredProjection(projection(true)) as {
      schemaVersion: number;
      flights: Array<Record<string, unknown>>;
    };
    // Still a schema-2 document: an older build reads it with Reflect.get and
    // never asks for routePath, so the published map keeps rendering.
    expect(stored.schemaVersion).toBe(2);
    expect(stored.flights[0].routePath).toEqual(
      projection(true).flights[0].routePath,
    );
    expect(stored.flights[0].routeIds).toBeDefined();
  });

  it("carries no private row data with the path", () => {
    const stored = JSON.stringify(
      rollbackCompatibleStoredProjection(projection(true)),
    );
    // The snapshot describes places, not source rows.
    for (const leak of ["routeRaw", "flightId", "rawSnapshot", "sourceRowKey"]) {
      expect(stored).not.toContain(leak);
    }
  });
});

describe("public waypoints are drawn but never counted", () => {
  const withWaypoints = derivePublicMapSlice(
    projection(true),
    DEFAULT_PUBLIC_MAP_FILTERS,
  );
  const withoutWaypoints = derivePublicMapSlice(
    projection(false),
    DEFAULT_PUBLIC_MAP_FILTERS,
  );

  it("leaves every public statistic identical", () => {
    expect(withWaypoints.summary).toEqual(withoutWaypoints.summary);
    expect(withWaypoints.routes).toEqual(withoutWaypoints.routes);
    // One airport, because the pilot landed at exactly one.
    expect(withWaypoints.summary.airportCount).toBe(1);
    expect(withWaypoints.summary.routeCount).toBe(1);
  });

  it("keeps the overflown airport out of the shared visited-airport list", () => {
    const shared = toSharedMapData(
      withWaypoints.routes,
      withWaypoints.routePathFlights,
    );
    expect(shared.airports.map(({ code }) => code)).toEqual(["S05"]);
    expect(
      toSharedMapData(withoutWaypoints.routes, withoutWaypoints.routePathFlights)
        .airports,
    ).toEqual(shared.airports);
  });

  it("hands FlightGlobe the same ordered path the private map builds", () => {
    const shared = toSharedMapData(
      withWaypoints.routes,
      withWaypoints.routePathFlights,
    );
    expect(shared.routePathFlights).toHaveLength(1);
    expect(
      shared.routePathFlights[0].routePath?.map((node) => [
        node.airport.code,
        node.kind,
      ]),
    ).toEqual([
      ["S05", "landing"],
      ["KRBG", "waypoint"],
      ["S05", "landing"],
    ]);
    // Landings only, so nothing downstream can read the waypoint as a stop.
    expect(
      shared.routePathFlights[0].airportSequence?.map(({ code }) => code),
    ).toEqual(["S05", "S05"]);
    // Positional id: the owner's flight id never reaches a public page.
    expect(shared.routePathFlights[0].id).toBe("shared-path-0");
  });

  it("produces geometry byte-identical to the private map's", () => {
    // Same helpers, same inputs, same output — this is the assertion that
    // fails if the shared view ever grows its own rendering model.
    const shared = toSharedMapData(
      withWaypoints.routes,
      withWaypoints.routePathFlights,
    );
    const privateFlight: Flight = {
      id: "shared-path-0",
      date: "2026-05-01",
      origin: { ...S05 },
      destination: { ...S05 },
      airportSequence: [{ ...S05 }, { ...S05 }],
      routePath: [
        { airport: { ...S05 }, kind: "landing" },
        { airport: { ...KRBG }, kind: "waypoint" },
        { airport: { ...S05 }, kind: "landing" },
      ],
      kind: "private",
      role: "pilot",
      aircraft: "C172",
      source: "ForeFlight",
      distanceMiles: 0,
    };
    expect(
      createFlightRoutePathFeatureCollection(shared.routePathFlights),
    ).toEqual(createFlightRoutePathFeatureCollection([privateFlight]));
    expect(
      createRouteWaypointFeatureCollection(shared.routePathFlights),
    ).toEqual(createRouteWaypointFeatureCollection([privateFlight]));
    expect(
      createRouteWaypointFeatureCollection(
        shared.routePathFlights,
      ).features.map(({ properties }) => properties.code),
    ).toEqual(["KRBG"]);
  });

  it("drops the path when its flight is filtered out", () => {
    const filtered = derivePublicMapSlice(projection(true), {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "passenger",
    });
    expect(filtered.routePathFlights).toEqual([]);
    expect(
      toSharedMapData(filtered.routes, filtered.routePathFlights)
        .routePathFlights,
    ).toEqual([]);
  });
});
