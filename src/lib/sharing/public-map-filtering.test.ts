import { describe, expect, it } from "vitest";
import type { PublicMapProjection } from "./service";
import { airportExactIdentity } from "@/lib/flight-data";
import {
  DEFAULT_PUBLIC_MAP_FILTERS,
  derivePublicMapSlice,
  publicMapFilterOptions,
  publicMapFilterOptionsForFilters,
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
  schemaVersion: 4,
  owner: { displayName: "Devin" },
  summary: { flightCount: 3, routeCount: 3 },
  routes: [
    {
      id: "sea-jfk-commercial",
      kind: "commercial",
      flightCount: 2,
      forwardFlightCount: 2,
      reverseFlightCount: 0,
      directionMode: "one-way",
      origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
      destination: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
    },
    {
      id: "jfk-lhr-commercial",
      kind: "commercial",
      flightCount: 1,
      forwardFlightCount: 1,
      reverseFlightCount: 0,
      directionMode: "one-way",
      origin: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
      destination: airport("LHR", "London Heathrow", "London", "GB", 51.471, -0.461),
    },
    {
      id: "sea-pdx-private",
      kind: "private",
      flightCount: 1,
      forwardFlightCount: 1,
      reverseFlightCount: 0,
      directionMode: "one-way",
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
      routeLegs: [
        { routeId: "sea-jfk-commercial", direction: "forward" },
      ],
    },
    {
      date: "2026-02-15",
      kind: "commercial",
      role: "pilot",
      aircraft: ["Boeing 777"],
      registration: "N777AA",
      routeLegs: [
        { routeId: "sea-jfk-commercial", direction: "forward" },
        { routeId: "jfk-lhr-commercial", direction: "forward" },
      ],
    },
    {
      date: "2026-03-20",
      kind: "private",
      role: "pilot",
      aircraft: ["Cessna 172"],
      registration: "N172ZZ",
      routeLegs: [
        { routeId: "sea-pdx-private", direction: "forward" },
      ],
    },
  ],
};

describe("public map viewer filtering", () => {
  it("shows all shared flights by default with current-view statistics", () => {
    expect(
      derivePublicMapSlice(projection, DEFAULT_PUBLIC_MAP_FILTERS),
    ).toEqual({
      routes: projection.routes,
      // No flight in this fixture overflew anywhere, so the presentation-only
      // payload is empty and the shared map draws exactly what it always did.
      routePathFlights: [],
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
      ...DEFAULT_PUBLIC_MAP_FILTERS,
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

  it("preserves canonical direction semantics through viewer-local filtering", () => {
    const canonical = {
      ...projection.routes[0]!,
      flightCount: 2,
      forwardFlightCount: 1,
      reverseFlightCount: 1,
      directionMode: "both" as const,
    };
    const bidirectionalProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount: 2, routeCount: 1 },
      routes: [canonical],
      flights: [
        {
          ...projection.flights[0]!,
          routeLegs: [
            { routeId: canonical.id, direction: "forward" as const },
          ],
        },
        {
          ...projection.flights[1]!,
          routeLegs: [
            { routeId: canonical.id, direction: "reverse" as const },
          ],
        },
      ],
    };
    const all = derivePublicMapSlice(
      bidirectionalProjection,
      DEFAULT_PUBLIC_MAP_FILTERS,
    );
    expect(all.routes[0]).toMatchObject({
      forwardFlightCount: 1,
      reverseFlightCount: 1,
      directionMode: "both",
    });
    const passenger = derivePublicMapSlice(bidirectionalProjection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "passenger",
    });
    expect(passenger.routes[0]).toMatchObject({
      forwardFlightCount: 1,
      reverseFlightCount: 0,
      directionMode: "one-way",
    });
    const pilot = derivePublicMapSlice(bidirectionalProjection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "pilot",
    });
    expect(pilot.routes[0]).toMatchObject({
      forwardFlightCount: 0,
      reverseFlightCount: 1,
      directionMode: "one-way",
    });
  });

  it("deduplicates and sorts public filter options", () => {
    expect(publicMapFilterOptions(projection)).toEqual({
      aircraft: ["B737", "Boeing 737", "Boeing 777", "Cessna 172"].map(
        (value) => ({ value, available: true }),
      ),
      registrations: ["N172ZZ", "N777AA", "N12345"].map((value) => ({
        value,
        available: true,
      })),
      airports: [
        projection.routes[0]!.destination,
        projection.routes[1]!.destination,
        projection.routes[2]!.destination,
        projection.routes[0]!.origin,
      ].map((value) => ({
        value: airportKey(value),
        label: `${value.code} — ${value.name}, ${value.city}`,
        searchText: `${value.code} ${value.name} ${value.city} ${value.country}`,
        available: true,
      })),
    });
  });

  it("filters by a real airport identity without mutating the projection", () => {
    const before = structuredClone(projection);
    const slice = derivePublicMapSlice(projection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      airport: airportKey(projection.routes[1]!.destination),
    });
    expect(slice.summary).toEqual({
      flightCount: 1,
      routeCount: 2,
      airportCount: 3,
      countryCount: 2,
    });
    expect(slice.routes.map(({ id }) => id)).toEqual([
      "sea-jfk-commercial",
      "jfk-lhr-commercial",
    ]);
    expect(projection).toEqual(before);
  });

  it("marks options unavailable when they conflict with active filters", () => {
    const options = publicMapFilterOptionsForFilters(projection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "passenger",
    });
    expect(options.aircraft).toEqual([
      { value: "B737", available: true },
      { value: "Boeing 737", available: true },
      { value: "Boeing 777", available: false },
      { value: "Cessna 172", available: false },
    ]);
    expect(options.registrations).toEqual([
      { value: "N172ZZ", available: false },
      { value: "N777AA", available: false },
      { value: "N12345", available: true },
    ]);
    expect(
      options.airports.map(({ label, available }) => ({ label, available })),
    ).toEqual([
      { label: "JFK — John F Kennedy, New York", available: true },
      { label: "LHR — London Heathrow, London", available: false },
      { label: "PDX — Portland International, Portland", available: false },
      { label: "SEA — Seattle, Seattle", available: true },
    ]);
  });

  function airportKey(
    value: PublicMapProjection["routes"][number]["origin"],
  ): string {
    return airportExactIdentity(value);
  }

  it("processes a large uncapped projection in linear time", () => {
    const flightCount = 25_000;
    const largeProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount, routeCount: 1 },
      routes: [{
        ...projection.routes[0],
        flightCount,
        forwardFlightCount: flightCount,
      }],
      flights: Array.from({ length: flightCount }, (_, index) => ({
        date: "2026-08-01",
        kind: "commercial" as const,
        role: index % 2 ? ("pilot" as const) : ("passenger" as const),
        aircraft: ["Boeing 737"],
        registration: "N12345",
        routeLegs: [
          { routeId: "sea-jfk-commercial", direction: "forward" as const },
        ],
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

  it("derives availability linearly across unique metadata values", () => {
    const flightCount = 10_000;
    const largeProjection: PublicMapProjection = {
      ...projection,
      summary: { flightCount, routeCount: 1 },
      routes: [{
        ...projection.routes[0],
        flightCount,
        forwardFlightCount: flightCount,
      }],
      flights: Array.from({ length: flightCount }, (_, index) => ({
        date: "2026-08-01",
        kind: "commercial" as const,
        role: index % 2 ? ("pilot" as const) : ("passenger" as const),
        aircraft: [`Aircraft ${index}`],
        registration: `N${index}`,
        routeLegs: [
          { routeId: "sea-jfk-commercial", direction: "forward" as const },
        ],
      })),
    };
    const startedAt = performance.now();
    const options = publicMapFilterOptionsForFilters(largeProjection, {
      ...DEFAULT_PUBLIC_MAP_FILTERS,
      role: "pilot",
    });
    expect(options.aircraft).toHaveLength(flightCount);
    expect(options.registrations).toHaveLength(flightCount);
    expect(options.aircraft.filter(({ available }) => available)).toHaveLength(
      flightCount / 2,
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
