import { describe, expect, it } from "vitest";
import type { Airport, Flight } from "./flight-data";
import { createRouteFeatureCollection } from "./map-geojson";
import { aggregateRoutesFromFlights } from "./route-aggregation";

const lax: Airport = {
  code: "LAX",
  name: "Los Angeles International",
  city: "Los Angeles",
  country: "United States",
  lat: 33.9425,
  lon: -118.4081,
  facility: "commercial",
};
const lap: Airport = {
  code: "LAP",
  name: "Manuel Márquez de León International",
  city: "La Paz",
  country: "Mexico",
  lat: 24.0727,
  lon: -110.3625,
  facility: "commercial",
};

describe("unordered route aggregation", () => {
  it("renders LAX-LAP outbound and return flights as one intensified route", () => {
    const routes = aggregateRoutesFromFlights([
      routeFlight("out-1", lax, lap),
      routeFlight("return", lap, lax),
      routeFlight("out-2", lax, lap),
    ]);
    const feature = createRouteFeatureCollection(routes).features[0];

    expect(routes).toHaveLength(1);
    expect(routes[0].flightCount).toBe(3);
    expect(
      [routes[0].forwardFlightCount, routes[0].reverseFlightCount].sort(),
    ).toEqual([1, 2]);
    expect(feature.properties.laneOffset).toBe(0);
    expect(feature.properties.bidirectional).toBe(true);
    expect(routes[0].directionMode).toBe("both");
    expect(feature.properties.directionMode).toBe("both");
    expect(feature.properties.directionCue).toBe("↔");
    expect(feature.properties.routeLabel).toContain("LAX");
    expect(feature.properties.routeLabel).toContain("LAP");
  });

  it("aggregates repeated same-direction flights and keeps a clear direction", () => {
    const routes = aggregateRoutesFromFlights([
      routeFlight("one", lax, lap),
      routeFlight("two", lax, lap),
      routeFlight("three", lax, lap),
    ]);

    expect(routes).toHaveLength(1);
    expect(routes[0].flightCount).toBe(3);
    expect(
      Math.max(
        routes[0].forwardFlightCount ?? 0,
        routes[0].reverseFlightCount ?? 0,
      ),
    ).toBe(3);
    expect(createRouteFeatureCollection(routes).features[0].properties.directionCue)
      .toBe("➤");
  });

  it("uses persisted airport identity for aliases without merging distinct airports", () => {
    const lowerLax = { ...lax, identity: "airport-lax", code: "lax" };
    const aliasLax = { ...lax, identity: "airport-lax", code: "KLAX" };
    const otherLax = {
      ...lax,
      identity: "airport-other",
      lat: lax.lat + 0.5,
      name: "Different airport",
    };
    const routes = aggregateRoutesFromFlights([
      routeFlight("lower", lowerLax, lap),
      routeFlight("alias", lap, aliasLax),
      routeFlight("different", otherLax, lap),
    ]);

    expect(routes).toHaveLength(2);
    expect(routes.find(({ flightCount }) => flightCount === 2)?.origin.code)
      .toMatch(/LAX|LAP/);
    expect(
      routes
        .flatMap(({ origin, destination }) => [origin.code, destination.code])
        .some((code) => code === "lax"),
    ).toBe(false);
  });

  it("does not merge distinct airports whose coordinates differ below five decimal places", () => {
    const closeLax = { ...lax, lat: lax.lat + 0.000001 };
    const routes = aggregateRoutesFromFlights([
      routeFlight("lax", lax, lap),
      routeFlight("close", closeLax, lap),
    ]);

    expect(routes).toHaveLength(2);
    expect(routes.map(({ flightCount }) => flightCount)).toEqual([1, 1]);
  });

  it("keeps identity tuples distinct when metadata contains separators", () => {
    const first = { ...lax, code: "DUP", name: "Alpha|Beta", city: "Gamma" };
    const second = { ...lax, code: "DUP", name: "Alpha", city: "Beta|Gamma" };
    const routes = aggregateRoutesFromFlights([
      routeFlight("first", first, lap),
      routeFlight("second", second, lap),
    ]);

    expect(routes).toHaveLength(2);
  });

  it("keeps route ids distinct when legacy 32-bit identity tokens collide", () => {
    const first = {
      ...lax,
      identity: "e0a8945c-4d11-4f78-aec4-dfa8f940cca0",
    };
    const second = {
      ...lax,
      identity: "7cf35a11-688a-4b82-9c33-33e51fbac0d7",
      name: "Distinct airport",
    };
    const routes = aggregateRoutesFromFlights([
      routeFlight("first", first, lap),
      routeFlight("second", second, lap),
    ]);

    expect(routes).toHaveLength(2);
    expect(new Set(routes.map(({ id }) => id)).size).toBe(2);
  });

  it("uses the same stable geometry key regardless of direction or input order", () => {
    const outbound = aggregateRoutesFromFlights([
      routeFlight("out", lax, lap),
      routeFlight("back", lap, lax),
    ])[0];
    const reversed = aggregateRoutesFromFlights([
      routeFlight("back", lap, lax),
      routeFlight("out", lax, lap),
    ])[0];

    expect(outbound.id).toBe(reversed.id);
    expect(outbound.origin).toEqual(reversed.origin);
    expect(outbound.destination).toEqual(reversed.destination);
  });

  it("scales aggregate intensity from total traffic in both directions", () => {
    const quietAirport = { ...lap, code: "SJD", lat: 23.1518, lon: -109.721 };
    const routes = aggregateRoutesFromFlights([
      routeFlight("out-1", lax, lap),
      routeFlight("back", lap, lax),
      routeFlight("out-2", lax, lap),
      routeFlight("quiet", lax, quietAirport),
    ]);
    const features = createRouteFeatureCollection(routes).features;
    const busy = features.find(({ properties }) => properties.flightCount === 3)!;
    const quiet = features.find(({ properties }) => properties.flightCount === 1)!;

    expect(busy.properties.strength).toBeGreaterThan(quiet.properties.strength);
  });
});

function routeFlight(
  id: string,
  origin: Airport,
  destination: Airport,
): Flight {
  return {
    id,
    date: "2026-08-01",
    origin,
    destination,
    kind: "commercial",
    role: "passenger",
    aircraft: "Airbus A320",
    distanceMiles: 800,
    source: "CSV",
  };
}
