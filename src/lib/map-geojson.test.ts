import { describe, expect, it } from "vitest";
import { airportExactIdentity, airports, mapRoutes } from "./flight-data";
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
    expect(collection.features[0].properties.directionMode).toBe("both");
    expect(collection.features[0].properties.directionCue).toBe("↔");
    expect(collection.features[0].properties.routeTitle).toBe("PAE ↔ SEA");
    expect(collection.features[0].properties.routeLabel).toContain("flights");
    expect(collection.features[0].properties).not.toHaveProperty("aircraft");
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
      collection.features.map(({ properties }) => properties.directionCue),
    ).toEqual(["➤", "➤", "➤"]);
  });

  it("keeps truthful cues on modest and dense routes for collision handling", () => {
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
        ?.properties.directionMode,
    ).toBe("one-way");
    expect(
      collection.features.find(({ properties }) => properties.id === "dense")
        ?.properties.directionMode,
    ).toBe("one-way");
  });

  it("normalizes reverse-only geometry and labels to actual flown direction", () => {
    const route = mapRoutes.find(({ id }) => id === "route-pae-sea")!;
    const collection = createRouteFeatureCollection([{
      ...route,
      forwardFlightCount: 0,
      reverseFlightCount: 4,
      flightCount: 4,
    }]);

    expect(collection.features[0].properties.routeTitle).toBe("SEA ➤ PAE");
    expect(collection.features[0].properties.directionCue).toBe("➤");
    const coordinates =
      collection.features[0].geometry.coordinates.flat();
    expect(coordinates[0][0]).toBeCloseTo(airports.SEA.lon);
    expect(coordinates[0][1]).toBeCloseTo(airports.SEA.lat);
    expect(coordinates.at(-1)?.[0]).toBeCloseTo(airports.PAE.lon);
    expect(coordinates.at(-1)?.[1]).toBeCloseTo(airports.PAE.lat);
  });

  it("does not invent a cue when directional counts contain no evidence", () => {
    const route = mapRoutes.find(({ id }) => id === "route-pae-sea")!;
    const collection = createRouteFeatureCollection([{
      ...route,
      forwardFlightCount: 0,
      reverseFlightCount: 0,
    }]);

    expect(collection.features[0].properties.directionMode).toBe("none");
    expect(collection.features[0].properties.directionCue).toBe("");
    expect(collection.features[0].properties.routeTitle).toBe("PAE — SEA");
  });

  it("keeps traffic, activity, and direction separate for duplicate display codes", () => {
    const active = { ...airports.SEA, code: "DUP" };
    const inactive = {
      ...airports.SEA,
      code: "DUP",
      name: "London duplicate",
      lat: 51.47,
      lon: -0.45,
    };
    const destination = {
      ...airports.SEA,
      code: "DUP",
      name: "Portland duplicate",
      lat: 45.59,
      lon: -122.6,
    };
    const route = {
      id: "duplicate-code-route",
      origin: active,
      destination,
      kind: "commercial" as const,
      flightCount: 2,
    };

    const airportCollection = createAirportFeatureCollection(
      [active, inactive, destination],
      [route],
    );
    const activeFeatures = airportCollection.features.filter(
      ({ properties }) => properties.isActive,
    );
    expect(activeFeatures).toHaveLength(2);
    expect(
      new Set(
        airportCollection.features.map(({ properties }) => properties.identity),
      ).size,
    ).toBe(3);
    expect(
      airportCollection.features.find(
        ({ geometry }) => geometry.coordinates[0] === inactive.lon,
      )?.properties,
    ).toMatchObject({ traffic: 0, isActive: false });

    const routeProperties =
      createRouteFeatureCollection([route]).features[0]!.properties;
    expect(routeProperties).toMatchObject({
      directionMode: "one-way",
      originIdentity: airportExactIdentity(active),
      destinationIdentity: airportExactIdentity(destination),
    });
  });
});
