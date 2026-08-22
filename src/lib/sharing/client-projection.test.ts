import { describe, expect, it } from "vitest";
import {
  parsePublicMapProjection,
  PublicMapProjectionValidationError,
} from "./client-projection";

function airport(
  code: string,
  name: string,
  city: string,
  country: string,
  lat: number,
  lon: number,
  facility: "commercial" | "general-aviation" | "airstrip",
) {
  return { code, name, city, country, lat, lon, facility };
}

const projection = {
  schemaVersion: 2,
  owner: { displayName: null },
  summary: { flightCount: 1, routeCount: 1 },
  routes: [
    {
      id: "route-1",
      kind: "commercial",
      flightCount: 1,
      origin: airport(
        "SEA",
        "Seattle-Tacoma International Airport",
        "Seattle",
        "US",
        47.44898,
        -122.30931,
        "commercial",
      ),
      destination: airport(
        "JFK",
        "John F Kennedy International Airport",
        "New York",
        "US",
        40.63993,
        -73.77869,
        "commercial",
      ),
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
  it("accepts only the real-airport public projection contract", () => {
    expect(parsePublicMapProjection(projection)).toEqual(projection);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        accountId: "private-owner",
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("rejects legacy snapshots so they cannot fabricate airport dimensions", () => {
    const legacyProjection = {
      owner: projection.owner,
      summary: projection.summary,
      routes: projection.routes.map((route) => ({
        ...route,
        origin: { lat: route.origin.lat, lon: route.origin.lon, country: "US" },
        destination: {
          lat: route.destination.lat,
          lon: route.destination.lon,
          country: "US",
        },
      })),
    };
    expect(() => parsePublicMapProjection(legacyProjection)).toThrow(
      PublicMapProjectionValidationError,
    );
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        flights: null,
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("accepts public airport coordinates and rejects malformed locations", () => {
    expect(
      parsePublicMapProjection(projection).routes[0]?.origin,
    ).toMatchObject({
      code: "SEA",
      name: "Seattle-Tacoma International Airport",
      lat: 47.44898,
    });
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
            origin: { ...projection.routes[0].origin, lat: 91 },
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("accepts real R-number airports and rejects private airport fields", () => {
    expect(
      parsePublicMapProjection({
        ...projection,
        routes: [
          {
            ...projection.routes[0],
            origin: { ...projection.routes[0].origin, code: "R47" },
          },
        ],
      }).routes[0]?.origin.code,
    ).toBe("R47");
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        routes: [
          {
            ...projection.routes[0],
            origin: {
              ...projection.routes[0].origin,
              airportId: "private-airport-id",
            },
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
        schemaVersion: 2,
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
