import { describe, expect, it } from "vitest";
import type { Airport, MapRoute } from "./flight-data";
import { createMapDataReadiness } from "./map-data-readiness";
import { createRouteFeatureCollection } from "./map-geojson";

const MEL: Airport = {
  code: "MEL",
  name: "Melbourne Airport",
  city: "Melbourne",
  country: "AU",
  lat: -37.670732,
  lon: 144.837898,
  facility: "commercial",
};
const SYD: Airport = {
  code: "SYD",
  name: "Sydney Kingsford Smith International Airport",
  city: "Sydney",
  country: "AU",
  lat: -33.946098,
  lon: 151.177002,
  facility: "commercial",
};
const route: MapRoute = {
  id: "flight-route-commercial-MEL-SYD",
  origin: MEL,
  destination: SYD,
  kind: "commercial",
  flightCount: 1,
};

describe("map data readiness", () => {
  it("uses delayed route data that arrives before the map style is ready", () => {
    const state = createMapDataReadiness({
      airports: [] as Airport[],
      routes: [] as MapRoute[],
      visibleKind: "all" as const,
      focusAirportCode: "",
    });

    state.setLatest({
      airports: [MEL, SYD],
      routes: [route],
      visibleKind: "commercial" as const,
      focusAirportCode: "MEL",
    });
    expect(state.currentIfReady()).toBeUndefined();

    const ready = state.markReady();
    expect(ready.routes).toEqual([route]);
    expect(ready.focusAirportCode).toBe("MEL");
    expect(createRouteFeatureCollection(ready.routes).features).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          originCode: "MEL",
          destinationCode: "SYD",
        }),
      }),
    ]);
  });

  it("retains the latest filter and route snapshot after readiness", () => {
    const state = createMapDataReadiness({
      airports: [MEL, SYD],
      routes: [route],
      visibleKind: "all" as "all" | "commercial",
      focusAirportCode: "",
    });
    state.markReady();
    state.setLatest({
      airports: [MEL, SYD],
      routes: [route],
      visibleKind: "commercial",
      focusAirportCode: "SYD",
    });

    expect(state.currentIfReady()).toMatchObject({
      routes: [route],
      visibleKind: "commercial",
      focusAirportCode: "SYD",
    });
  });
});
