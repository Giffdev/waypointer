import { describe, expect, it } from "vitest";
import { aggregateStatsSlice, type StatsPeriod } from "./flight-statistics";
import { statsFactsFromFlights } from "./flight-insights";
import type { Airport, Flight } from "./flight-data";
import { flightAirportSequence } from "./flight-data";
import {
  createAirportFeatureCollection,
  createFlightRoutePathFeatureCollection,
  createRouteWaypointFeatureCollection,
} from "./map-geojson";
import {
  AIRPORT_LAYER_IDS,
  buildAirportMarkerLayer,
  buildOverflownPathLayer,
  buildOverflownWaypointLayers,
  OVERFLOWN_LAYER_IDS,
} from "./map-style";
import { aggregateRoutesFromFlights } from "./route-aggregation";

/**
 * Private-map route path rendering.
 *
 * The rule these tests defend: a waypoint is *drawn* and never *counted*. The
 * pilot has to be able to see that a flight went S05 → KRBG → S05, and no
 * statistic, unique-airport total, or airport marker may move because of it.
 */

const airport = (code: string, lat: number, lon: number): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Example",
  country: "US",
  lat,
  lon,
  facility: "general-aviation",
});

const S05 = airport("S05", 43.0, -124.4);
const KRBG = airport("KRBG", 43.2, -123.3);
const KEUG = airport("KEUG", 44.1, -123.2);

const baseFlight = {
  kind: "private" as const,
  role: "pilot" as const,
  aircraft: "C172",
  source: "ForeFlight" as const,
  durationHours: 1.5,
  distanceMiles: 120,
};

/** The out-and-back the directive names: departs and lands at S05. */
const outAndBack: Flight = {
  ...baseFlight,
  id: "flight-out-and-back",
  date: "2026-05-01",
  origin: S05,
  destination: S05,
  airportSequence: [S05, S05],
  routePath: [
    { airport: S05, kind: "landing" },
    { airport: KRBG, kind: "waypoint" },
    { airport: S05, kind: "landing" },
  ],
  routeRaw: "S05 KRBG S05",
};

/** Same flight as recorded before route waypoints existed. */
const outAndBackLandingsOnly: Flight = {
  ...baseFlight,
  id: "flight-out-and-back",
  date: "2026-05-01",
  origin: S05,
  destination: S05,
  airportSequence: [S05, S05],
};

const crossCountry: Flight = {
  ...baseFlight,
  id: "flight-cross-country",
  date: "2026-05-02",
  origin: S05,
  destination: KEUG,
  airportSequence: [S05, KEUG],
};

const period: StatsPeriod = {
  preset: "any",
  startDate: "2026-01-01",
  endDateExclusive: "2027-01-01",
  isPartial: false,
  elapsedDays: 365,
};

describe("private map route path geometry", () => {
  it("draws S05 -> KRBG -> S05 in order, bending through the waypoint", () => {
    const collection = createFlightRoutePathFeatureCollection([outAndBack]);
    expect(collection.features).toHaveLength(1);
    const [feature] = collection.features;
    expect(feature.properties.pathCodes).toEqual(["S05", "KRBG", "S05"]);
    expect(feature.properties.routeLabel).toBe("S05 → KRBG → S05");
    expect(feature.properties.hasWaypoints).toBe(true);

    // Order is the whole point. A straight S05→S05 line is zero-length and
    // would render nothing at all; the drawn geometry has to reach KRBG and
    // come back, so its extreme longitude is the waypoint's, not an endpoint's.
    const longitudes = feature.geometry.coordinates
      .flat()
      .map(([longitude]) => longitude);
    expect(Math.max(...longitudes)).toBeGreaterThan(S05.lon + 0.5);
    expect(Math.max(...longitudes)).toBeCloseTo(KRBG.lon, 1);
    // Out and back: the first drawn point and the last are the same airport.
    const first = feature.geometry.coordinates[0][0];
    const lastSegment = feature.geometry.coordinates.at(-1)!;
    expect(first[0]).toBeCloseTo(S05.lon, 3);
    expect(lastSegment.at(-1)![0]).toBeCloseTo(S05.lon, 3);
  });

  it("falls back to exactly the landing-only path when there is no routePath", () => {
    const withRoute = createFlightRoutePathFeatureCollection([outAndBack])
      .features[0];
    const withoutRoute = createFlightRoutePathFeatureCollection([
      crossCountry,
    ]).features[0];
    expect(withoutRoute.properties.pathCodes).toEqual(["S05", "KEUG"]);
    expect(withoutRoute.properties.waypointCodes).toEqual([]);
    expect(withoutRoute.properties.hasWaypoints).toBe(false);
    // And the layer filter is what keeps a landing-only flight off the
    // overflown layer entirely, so it renders exactly as it always did.
    expect(buildOverflownPathLayer("source").filter).toEqual([
      "==",
      ["get", "hasWaypoints"],
      true,
    ]);
    expect(withRoute.properties.hasWaypoints).toBe(true);
  });

  it("makes the waypoint airport itself visible as its own point", () => {
    const collection = createRouteWaypointFeatureCollection([outAndBack]);
    expect(
      collection.features.map(({ properties }) => properties.code),
    ).toEqual(["KRBG"]);
    expect(collection.features[0].geometry.coordinates).toEqual([
      KRBG.lon,
      KRBG.lat,
    ]);
    expect(collection.features[0].properties.routeLabels).toEqual([
      "S05 → KRBG → S05",
    ]);
  });

  it("never re-draws an airport that is a landing somewhere as overflown", () => {
    // KEUG is overflown on one flight and landed at on another. A visited
    // airport must not also carry the hollow "passed over" mark.
    const overflyingKeug: Flight = {
      ...baseFlight,
      id: "flight-overflies-keug",
      date: "2026-05-03",
      origin: S05,
      destination: KRBG,
      airportSequence: [S05, KRBG],
      routePath: [
        { airport: S05, kind: "landing" },
        { airport: KEUG, kind: "waypoint" },
        { airport: KRBG, kind: "landing" },
      ],
    };
    const codes = createRouteWaypointFeatureCollection([
      overflyingKeug,
      crossCountry,
    ]).features.map(({ properties }) => properties.code);
    expect(codes).toEqual([]);
  });
});

describe("route waypoints never move a statistic or a marker", () => {
  it("keeps every statistic identical to the landings-only recording", () => {
    const withWaypoint = statsFactsFromFlights([outAndBack]);
    const withoutWaypoint = statsFactsFromFlights([outAndBackLandingsOnly]);
    expect(withWaypoint).toEqual(withoutWaypoint);
    expect(aggregateStatsSlice(withWaypoint, period)).toEqual(
      aggregateStatsSlice(withoutWaypoint, period),
    );
    // One airport visited, because the pilot landed at exactly one.
    expect(
      aggregateStatsSlice(withWaypoint, period).metrics.uniqueAirports.value,
    ).toBe(1);
    expect(flightAirportSequence(outAndBack).map(({ code }) => code)).toEqual([
      "S05",
      "S05",
    ]);
  });

  it("keeps the overflown waypoint out of the aggregated routes", () => {
    const routes = aggregateRoutesFromFlights([outAndBack]);
    for (const route of routes) {
      expect([route.origin.code, route.destination.code]).not.toContain("KRBG");
    }
  });

  it("keeps the airport marker source free of overflown points", () => {
    const routes = aggregateRoutesFromFlights([outAndBack]);
    const collection = createAirportFeatureCollection([S05, KRBG], routes);
    const krbg = collection.features.find(
      ({ properties }) => properties.code === "KRBG",
    );
    // KRBG may still be a contextual airport in the catalog, but it must not
    // be marked active — that is the map's word for "you have been here".
    expect(krbg?.properties.isActive ?? false).toBe(false);
  });

  it("renders overflown geometry from its own sources and layers", () => {
    // Sharing the route or airport source would make a waypoint inherit
    // frequency strength and visit semantics it does not have.
    const pathLayer = buildOverflownPathLayer("overflown-source");
    const [waypointLayer, waypointLabelLayer] =
      buildOverflownWaypointLayers("waypoint-source");
    expect(pathLayer.id).toBe(OVERFLOWN_LAYER_IDS.paths);
    expect(pathLayer.source).toBe("overflown-source");
    expect(pathLayer.paint?.["line-dasharray"]).toEqual([2, 2]);
    expect(waypointLayer.id).toBe(OVERFLOWN_LAYER_IDS.waypoints);
    expect(waypointLayer.source).toBe("waypoint-source");
    // Hollow: stroked, not filled, so it cannot be mistaken for a visited
    // airport marker.
    expect(waypointLayer.paint?.["circle-color"]).toBe("rgba(0,0,0,0)");
    expect(waypointLabelLayer.id).toBe(OVERFLOWN_LAYER_IDS.waypointLabels);
    expect(waypointLabelLayer.layout?.["text-field"]).toEqual(["get", "code"]);

    const markerLayer = buildAirportMarkerLayer("airport-source");
    expect(markerLayer.id).toBe(AIRPORT_LAYER_IDS.markers);
    expect(markerLayer.source).toBe("airport-source");
    expect(
      new Set([
        pathLayer.id,
        waypointLayer.id,
        waypointLabelLayer.id,
        markerLayer.id,
      ]).size,
    ).toBe(4);
  });
});
