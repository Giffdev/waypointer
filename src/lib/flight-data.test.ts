import { describe, expect, it } from "vitest";
import {
  airportExactIdentity,
  airports,
  airportsForRoutes,
  mapRoutes,
  mergeFlightCollections,
  mergeRouteCollections,
  sampleFlights,
  type MapRoute,
} from "./flight-data";

describe("map route collection merging", () => {
  it("retains commercial routes when a private local import is present", () => {
    const importedRoutes: MapRoute[] = [
      {
        id: "local-private",
        origin: airports.PAE,
        destination: airports.SEA,
        kind: "private",
        flightCount: 3,
      },
    ];

    const merged = mergeRouteCollections(mapRoutes, importedRoutes);

    expect(merged.some((route) => route.kind === "commercial")).toBe(true);
    expect(merged.filter((route) => route.kind === "private")).toEqual(importedRoutes);
  });

  it("uses the imported route when it matches a representative route", () => {
    const importedCommercial = { ...mapRoutes[0], flightCount: 99 };
    const merged = mergeRouteCollections(mapRoutes, [importedCommercial]);

    expect(merged.filter((route) => route.id === importedCommercial.id)).toHaveLength(1);
    expect(
      merged.find(
        (route) =>
          route.kind === importedCommercial.kind &&
          route.origin.code === importedCommercial.origin.code &&
          route.destination.code === importedCommercial.destination.code,
      )?.flightCount,
    ).toBe(99);
    expect(
      merged.filter(
        (route) => route.kind === "commercial" && route.id !== importedCommercial.id,
      ),
    ).toEqual([]);
  });

  it("keeps a personal fallback when an import only contains commercial routes", () => {
    const importedCommercial = { ...mapRoutes[0], id: "local-commercial" };
    const merged = mergeRouteCollections(mapRoutes, [importedCommercial]);

    expect(merged.some((route) => route.kind === "commercial")).toBe(true);
    expect(merged.some((route) => route.kind === "private")).toBe(true);
  });

  it("replaces representative flights only for kinds present in local data", () => {
    const importedCommercial = {
      ...sampleFlights[0],
      id: "local-commercial",
    };
    const merged = mergeFlightCollections(
      sampleFlights,
      [importedCommercial],
      ["commercial"],
    );

    expect(merged.filter((flight) => flight.kind === "commercial")).toEqual([
      importedCommercial,
    ]);
    expect(merged.some((flight) => flight.kind === "private")).toBe(true);
  });

  it("keeps distinct persisted airports that share a display code", () => {
    const first = { ...airports.SEA, identity: "airport-one", code: "DUP" };
    const second = { ...airports.PAE, identity: "airport-two", code: "DUP" };
    const collected = airportsForRoutes([
      {
        id: "same-code",
        origin: first,
        destination: second,
        kind: "private",
        flightCount: 1,
      },
    ]);

    expect(collected).toHaveLength(2);
    expect(new Set(collected.map(airportExactIdentity)).size).toBe(2);
  });
});
