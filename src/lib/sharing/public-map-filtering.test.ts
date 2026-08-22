import { describe, expect, it } from "vitest";
import type { PublicMapProjection } from "./service";
import {
  DEFAULT_PUBLIC_MAP_FILTERS,
  derivePublicMapSlice,
  publicMapFilterOptions,
} from "./public-map-filtering";

function airport(
  code: string,
  name: string,
  city: string,
  country: string,
  lat: number,
  lon: number,
) {
  return {
    code,
    name,
    city,
    country,
    lat,
    lon,
    facility: "commercial" as const,
  };
}

const projection: PublicMapProjection = {
  schemaVersion: 2,
  owner: { displayName: "Devin" },
  summary: { flightCount: 3, routeCount: 3 },
  routes: [
    {
      id: "sea-jfk-commercial",
      kind: "commercial",
      flightCount: 2,
      origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
      destination: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
    },
    {
      id: "jfk-lhr-commercial",
      kind: "commercial",
      flightCount: 1,
      origin: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
      destination: airport("LHR", "London Heathrow", "London", "GB", 51.471, -0.461),
    },
    {
      id: "sea-pdx-private",
      kind: "private",
      flightCount: 1,
      origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
      destination: airport("PDX", "Portland International", "Portland", "US", 45.589, -122.598),
    },
  ],
  flights: [
    {
      date: "2026-01-10",
      kind: "commercial",
      role: "passenger",
      aircraft: ["Boeing 737", "B737"],
      registration: "N12345",
      routeIds: ["sea-jfk-commercial"],
    },
    {
      date: "2026-02-15",
      kind: "commercial",
      role: "pilot",
      aircraft: ["Boeing 777"],
      registration: "N777AA",
      routeIds: ["sea-jfk-commercial", "jfk-lhr-commercial"],
    },
    {
      date: "2026-03-20",
      kind: "private",
      role: "pilot",
      aircraft: ["Cessna 172"],
      registration: "N172ZZ",
      routeIds: ["sea-pdx-private"],
    },
  ],
};

describe("public map viewer filtering", () => {
  it("shows all shared flights by default with current-view statistics", () => {
    expect(
      derivePublicMapSlice(projection, DEFAULT_PUBLIC_MAP_FILTERS),
    ).toEqual({
      routes: projection.routes,
      summary: {
        flightCount: 3,
        routeCount: 3,
        airportCount: 4,
        countryCount: 2,
      },
      filteringAvailable: true,
    });
  });

  it("combines role, inclusive dates, aircraft, and registration locally", () => {
    const slice = derivePublicMapSlice(projection, {
      role: "pilot",
      startDate: "2026-02-15",
      endDate: "2026-02-15",
      aircraft: "boeing 777",
      registration: "n777aa",
    });
    expect(slice.routes.map(({ id, flightCount }) => [id, flightCount])).toEqual(
      [
        ["sea-jfk-commercial", 1],
        ["jfk-lhr-commercial", 1],
      ],
    );
    expect(slice.summary).toEqual({
      flightCount: 1,
      routeCount: 2,
      airportCount: 3,
      countryCount: 2,
    });
  });

  it("returns an empty, internally consistent view when nothing matches", () => {
    expect(
      derivePublicMapSlice(projection, {
        ...DEFAULT_PUBLIC_MAP_FILTERS,
        startDate: "2027-01-01",
      }),
    ).toMatchObject({
      routes: [],
      summary: {
        flightCount: 0,
        routeCount: 0,
        airportCount: 0,
        countryCount: 0,
      },
    });

  });

  it("counts opposite directions as one visible route", () => {
    const forward = { ...projection.routes[0]!, flightCount: 1 };
    const reverse = {
      ...forward,
      id: "jfk-sea-commercial",
      origin: forward.destination,
      destination: forward.origin,
    };
    const bidirectionalProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount: 2, routeCount: 2 },
      routes: [forward, reverse],
      flights: [
        { ...projection.flights[0]!, routeIds: [forward.id] },
        {
          ...projection.flights[1]!,
          routeIds: [reverse.id],
        },
      ],
    };
    expect(
      derivePublicMapSlice(bidirectionalProjection, DEFAULT_PUBLIC_MAP_FILTERS)
        .summary.routeCount,
    ).toBe(1);
  });

  it("deduplicates and sorts public filter options", () => {
    expect(publicMapFilterOptions(projection)).toEqual({
      aircraft: ["B737", "Boeing 737", "Boeing 777", "Cessna 172"],
      registrations: ["N172ZZ", "N777AA", "N12345"],
    });
  });

  it("processes a large uncapped projection in linear time", () => {
    const flightCount = 25_000;
    const largeProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount, routeCount: 1 },
      routes: [{ ...projection.routes[0], flightCount }],
      flights: Array.from({ length: flightCount }, (_, index) => ({
        date: "2026-08-01",
        kind: "commercial" as const,
        role: index % 2 ? ("pilot" as const) : ("passenger" as const),
        aircraft: ["Boeing 737"],
        registration: "N12345",
        routeIds: ["sea-jfk-commercial"],
      })),
    };
    const startedAt = performance.now();
    const slice = derivePublicMapSlice(largeProjection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "pilot",
    });
    expect(slice.summary.flightCount).toBe(12_500);
    expect(slice.routes[0]?.flightCount).toBe(12_500);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
