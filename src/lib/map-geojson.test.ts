import { describe, expect, it } from "vitest";
import { airports, mapRoutes } from "./flight-data";
import { createAirportFeatureCollection, createRouteFeatureCollection } from "./map-geojson";

describe("MapLibre map data", () => {
  it("retains every route and splits dateline crossings safely", () => {
    const collection = createRouteFeatureCollection(mapRoutes);
    const transPacific = collection.features.find((feature) => feature.properties.id === "route-hnl-syd");

    expect(collection.features).toHaveLength(mapRoutes.length);
    expect(transPacific?.geometry.coordinates.length).toBeGreaterThan(1);
    expect(
      transPacific?.geometry.coordinates.every((line) =>
        line.every(([longitude]) => longitude >= -180 && longitude <= 180),
      ),
    ).toBe(true);
  });

  it("retains every airport and marks busy airports for world-view labels", () => {
    const collection = createAirportFeatureCollection(Object.values(airports), mapRoutes);

    expect(collection.features).toHaveLength(Object.values(airports).length);
    expect(collection.features.some((feature) => feature.properties.isHub)).toBe(true);
    expect(
      collection.features.find(({ properties }) => properties.code === "SEA")
        ?.properties.isActive,
    ).toBe(true);
    expect(
      collection.features.find(({ properties }) => properties.code === "1Q5")
        ?.properties.isActive,
    ).toBe(true);
    expect(collection.features.every((feature) => feature.properties.name.length > 0)).toBe(true);
  });

  it("keeps contextual airports visible and activates same-airport flights", () => {
    const sameAirportRoute = {
      id: "same-airport",
      origin: airports.PAE,
      destination: airports.PAE,
      kind: "private" as const,
      flightCount: 1,
    };
    const collection = createAirportFeatureCollection(
      [airports.PAE, airports.SEA],
      [sameAirportRoute],
    );

    expect(collection.features).toHaveLength(2);
    expect(
      collection.features.find(({ properties }) => properties.code === "PAE")
        ?.properties.isActive,
    ).toBe(true);
    expect(
      collection.features.find(({ properties }) => properties.code === "SEA")
        ?.properties.isActive,
    ).toBe(false);
  });

  it("keeps a bidirectional aggregate on one lane and exposes direction counts", () => {
    const route = mapRoutes.find(({ id }) => id === "route-pae-sea")!;
    const collection = createRouteFeatureCollection([{
      ...route,
      flightCount: 5,
      forwardFlightCount: 3,
      reverseFlightCount: 2,
    }]);

    const offsets = collection.features.map(({ properties }) => properties.laneOffset);
    expect(offsets).toEqual([0]);
    expect(collection.features[0].properties.forwardFlightCount).toBe(3);
    expect(collection.features[0].properties.reverseFlightCount).toBe(2);
    expect(collection.features[0].properties.bidirectional).toBe(true);
    expect(collection.features[0].properties.routeLabel).toContain("flights");
    expect(collection.features[0].properties).not.toHaveProperty("aircraft");
    expect(collection.features.every(({ properties }) => !properties.showDirection)).toBe(true);
  });

  it("shows one direction cue for each clear leg in an A-B-C-A trip", () => {
    const trip = [
      { id: "a-b", origin: airports.PAE, destination: airports.SEA },
      { id: "b-c", origin: airports.SEA, destination: airports.HNL },
      { id: "c-a", origin: airports.HNL, destination: airports.PAE },
    ].map((route) => ({
      ...route,
      kind: "commercial" as const,
      flightCount: 1,
    }));

    const collection = createRouteFeatureCollection(trip);

    expect(
      collection.features.map(({ properties }) => properties.showDirection),
    ).toEqual([true, true, true]);
  });

  it("keeps a single cue for modest repeats and suppresses dense routes", () => {
    const route = mapRoutes.find(({ id }) => id === "route-pae-sea")!;
    const collection = createRouteFeatureCollection([
      { ...route, id: "repeated", flightCount: 3 },
      {
        ...route,
        id: "dense",
        origin: airports.SEA,
        destination: airports.HNL,
        flightCount: 4,
      },
    ]);

    expect(
      collection.features.find(({ properties }) => properties.id === "repeated")
        ?.properties.showDirection,
    ).toBe(true);
    expect(
      collection.features.find(({ properties }) => properties.id === "dense")
        ?.properties.showDirection,
    ).toBe(false);
  });
});
