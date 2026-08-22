import { describe, expect, it } from "vitest";
import {
  parsePublicMapProjection,
  PublicMapProjectionValidationError,
} from "./client-projection";

const projection = {
  owner: { displayName: null },
  summary: { flightCount: 1, routeCount: 1 },
  routes: [
    {
      id: "route-1",
      kind: "commercial",
      flightCount: 1,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 40.6, lon: -73.8, country: "US" },
    },
  ],
  flights: [
    {
      date: "2026-08-01",
      kind: "commercial",
      role: "passenger",
      aircraft: ["Boeing 737"],
      registration: "N12345",
      routeIds: ["route-1"],
    },
  ],
};

describe("public map projection parser", () => {
  it("accepts only the coarse public projection contract", () => {
    expect(parsePublicMapProjection(projection)).toEqual(projection);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        accountId: "private-owner",
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("supports legacy snapshots without exposing fabricated dimensions", () => {
    const legacyProjection = {
      owner: projection.owner,
      summary: projection.summary,
      routes: projection.routes,
    };
    expect(parsePublicMapProjection(legacyProjection)).toEqual({
      ...legacyProjection,
      flights: null,
    });
    expect(
      parsePublicMapProjection({ ...legacyProjection, flights: null }),
    ).toEqual({
      ...legacyProjection,
      flights: null,
    });
  });

  it("rejects inconsistent counts and precise coordinates", () => {
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        summary: { flightCount: 2, routeCount: 1 },
      }),
    ).toThrow(PublicMapProjectionValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        routes: [
          {
            ...projection.routes[0],
            origin: { lat: 47.456, lon: -122.3, country: "US" },
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("rejects private flight fields and inconsistent route references", () => {
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        flights: [
          {
            ...projection.flights[0],
            notes: "private",
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        flights: [
          {
            ...projection.flights[0],
            routeIds: ["missing-route"],
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        flights: [
          {
            ...projection.flights[0],
            date: "2026-02-30",
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("rejects per-route count mismatches even when global totals match", () => {
    expect(() =>
      parsePublicMapProjection({
        owner: projection.owner,
        summary: { flightCount: 2, routeCount: 2 },
        routes: [
          { ...projection.routes[0], flightCount: 2 },
          {
            ...projection.routes[0],
            id: "route-2",
            flightCount: 1,
          },
        ],
        flights: [
          projection.flights[0],
          {
            ...projection.flights[0],
            routeIds: ["route-2", "route-2"],
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });
});
