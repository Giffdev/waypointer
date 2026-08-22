import { describe, expect, it } from "vitest";
import type { PublicMapProjection } from "./service";
import {
  DEFAULT_PUBLIC_MAP_FILTERS,
  derivePublicMapSlice,
  publicMapFilterOptions,
} from "./public-map-filtering";

const projection: PublicMapProjection = {
  owner: { displayName: "Devin" },
  summary: { flightCount: 3, routeCount: 3 },
  routes: [
    {
      id: "sea-jfk-commercial",
      kind: "commercial",
      flightCount: 2,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 40.6, lon: -73.8, country: "US" },
    },
    {
      id: "jfk-lhr-commercial",
      kind: "commercial",
      flightCount: 1,
      origin: { lat: 40.6, lon: -73.8, country: "US" },
      destination: { lat: 51.5, lon: -0.5, country: "GB" },
    },
    {
      id: "sea-pdx-private",
      kind: "private",
      flightCount: 1,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 45.6, lon: -122.6, country: "US" },
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
        regionCount: 4,
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
      regionCount: 3,
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
        regionCount: 0,
        countryCount: 0,
      },
    });
  });

  it("counts opposite directions as one visible route", () => {
    const forward = projection.routes[0]!;
    const reverse = {
      ...forward,
      id: "jfk-sea-commercial",
      origin: forward.destination,
      destination: forward.origin,
    };
    const legacyProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount: 2, routeCount: 2 },
      routes: [forward, reverse],
      flights: null,
    };
    expect(
      derivePublicMapSlice(legacyProjection, DEFAULT_PUBLIC_MAP_FILTERS)
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
