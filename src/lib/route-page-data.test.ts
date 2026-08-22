import { describe, expect, it } from "vitest";
import {
  getInitialFilters,
  serializeFiltersForHref,
} from "@/components/dashboard-shared";
import { airports, type Flight } from "./flight-data";
import { ALL_FLIGHT_FILTERS, type FlightFilters } from "./flight-filters";
import type { LocalFlightData } from "./local-flight-data";
import {
  buildFlightsPageContract,
  buildImportPageContract,
  buildMapPageContract,
} from "./route-page-data";
import {
  buildPersistedFlightData,
  buildPersistedFlightStatisticsContext,
} from "./persisted-flight-data";

describe("route URL and data contracts", () => {
  it("parses direct shared-filter deep links", () => {
    expect(
      getInitialFilters({
        type: "commercial",
        period: "custom",
        year: "2024",
        month: "9",
        aircraft: "Boeing 737-800",
        registration: "N123EX",
      }),
    ).toEqual({
      type: "commercial",
      period: "custom",
      year: 2024,
      month: 9,
      source: "all",
      aircraft: "Boeing 737-800",
      registration: "N123EX",
    });
  });

  it("normalizes standalone calendar filters to a custom period", () => {
    const filters = getInitialFilters({ month: "6" });
    expect(filters.period).toBe("custom");
    expect(filters.month).toBe(6);
  });

  it("drops stale calendar fields for quick periods", () => {
    expect(
      serializeFiltersForHref({
        ...ALL_FLIGHT_FILTERS,
        type: "pilot",
        period: "12m",
        year: 2020,
        month: 4,
      } as unknown as FlightFilters),
    ).toBe("?type=pilot&period=12m");
  });

  it("serializes legacy filter objects without undefined metadata values", () => {
    expect(
      serializeFiltersForHref({
        type: "private",
        period: "any",
        year: "all",
        month: "all",
      }),
    ).toBe("?type=private");
  });

  it("rejects invalid query values without throwing", () => {
    expect(
      getInitialFilters({
        type: "admin",
        period: "forever",
        year: "2",
        month: "13",
      }),
    ).toEqual({
      type: "all",
      period: "any",
      year: "all",
      month: "all",
      source: "all",
      aircraft: "all",
      registration: "all",
    });
  });

  it("parses and serializes bounded aircraft metadata filters", () => {
    const filters = getInitialFilters({
      aircraft: "Boeing 737-800",
      registration: "N123EX",
    });

    expect(filters).toMatchObject({
      aircraft: "Boeing 737-800",
      registration: "N123EX",
    });
    expect(serializeFiltersForHref(filters)).toBe(
      "?aircraft=Boeing+737-800&registration=N123EX",
    );
    expect(
      getInitialFilters({ aircraft: "\u0000bad", registration: "x".repeat(101) }),
    ).toMatchObject({ aircraft: "all", registration: "all" });
    expect(
      getInitialFilters({ aircraft: "98765", registration: "()" }),
    ).toMatchObject({ aircraft: "98765", registration: "all" });
  });

  it("canonicalizes source aliases and applies them to map and history data", () => {
    const foreFlight = getInitialFilters({ source: "foreflight" });
    const fr24 = getInitialFilters({ source: "fr24" });

    expect(foreFlight.source).toBe("ForeFlight");
    expect(fr24.source).toBe("FlightRadar24");
    expect(serializeFiltersForHref(foreFlight)).toBe("?source=ForeFlight");

    const map = buildMapPageContract(foreFlight, null, null);
    const flights = buildFlightsPageContract(foreFlight, null, null);
    expect(map.filteredFlightCount).toBeGreaterThan(0);
    expect(flights.flights).toHaveLength(map.filteredFlightCount);
    expect(flights.flights.every(({ source }) => source === "ForeFlight")).toBe(
      true,
    );
    expect(map.statsCards[0].value).toBe(
      map.filteredFlightCount.toLocaleString(),
    );
  });

  it("gives the map only map and aggregate fields", () => {
    const data = buildMapPageContract(getInitialFilters(), null, null);
    expect(data.routes.length).toBeGreaterThan(0);
    expect(data.airports.length).toBeGreaterThan(0);
    expect(data.statsCards.length).toBeGreaterThan(0);
    expect(data).not.toHaveProperty("flights");
    expect(data).not.toHaveProperty("facts");
  });

  it("counts distinct same-code airports in owner map statistics", () => {
    const first = {
      ...airports.SEA,
      identity: "first-sea",
    };
    const second = {
      ...airports.SEA,
      identity: "second-sea",
      name: "Distinct SEA airport",
      lat: airports.SEA.lat + 0.5,
    };
    const persisted = buildPersistedFlightData(
      [
        flight("first", { origin: first }),
        flight("second", { origin: second }),
      ],
      "2026-08-11T00:00:00.000Z",
    );
    const map = buildMapPageContract(getInitialFilters(), persisted, null);

    expect(
      map.statsCards.find(({ label }) => label === "Mapped airports")?.value,
    ).toBe("3");
  });

  it("never fills an authenticated empty account with representative samples", () => {
    const persisted = buildPersistedFlightData(
      [],
      "2026-08-11T00:00:00.000Z",
    );
    const map = buildMapPageContract(getInitialFilters(), persisted, null);
    const flights = buildFlightsPageContract(
      getInitialFilters(),
      persisted,
      null,
    );

    expect(map.dataMode).toBe("persisted");
    expect(map.filteredFlightCount).toBe(0);
    expect(map.routes).toEqual([]);
    expect(map.airports).toEqual([]);
    expect(flights.flights).toEqual([]);
  });

  it("gives Flights a sanitized flattened history", () => {
    const data = buildFlightsPageContract(
      getInitialFilters(),
      localData([
        flight("with-metadata", {
          aircraftType: "B738",
          aircraftModel: "Boeing 737-800",
          registration: "N123EX",
        }),
        flight("without-metadata"),
      ]),
      null,
    );
    expect(data.flights.length).toBeGreaterThan(0);
    expect(data.flights.find(({ id }) => id === "with-metadata")).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        date: expect.any(String),
        aircraft: expect.any(String),
        aircraftType: "B738",
        aircraftModel: "Boeing 737-800",
        registration: "N123EX",
        source: expect.any(String),
      }),
    );
    const payload = JSON.stringify(data);
    expect(payload).not.toContain("departureTime");
    expect(payload).not.toContain("arrivalTime");
    expect(payload).not.toContain("flightNumber");
    expect(payload).not.toContain("provenance");
    expect(payload).not.toContain("distanceMiles");
    expect(payload).not.toContain('"lat"');
    expect(payload).not.toContain('"lon"');
    expect(data.flights.find(({ id }) => id === "without-metadata"))
      .not.toHaveProperty("registration");
  });

  it("defaults route distances to nautical miles and preserves an explicit unit", () => {
    const distanceFlight = flight("distance", { distanceMiles: 100 });
    const data = buildPersistedFlightData([distanceFlight]);
    const statistics = buildPersistedFlightStatisticsContext([distanceFlight]);
    const defaultFlights = buildFlightsPageContract(
      getInitialFilters(),
      data,
      statistics,
    );
    const defaultMap = buildMapPageContract(
      getInitialFilters(),
      data,
      statistics,
    );
    const milesFlights = buildFlightsPageContract(
      getInitialFilters(),
      data,
      null,
      "miles",
    );

    expect(defaultFlights.distanceUnit).toBe("nautical_miles");
    expect(defaultFlights.flights[0].distance).toBe("87 NM");
    expect(defaultMap.statsCards.find(({ label }) => label === "Distance")?.value)
      .toBe("87 NM");
    expect(milesFlights.distanceUnit).toBe("miles");
    expect(milesFlights.flights[0].distance).toBe("100 mi");
  });

  it("keeps canonical ForeFlight registrations in sanitized filter and page contracts", () => {
    const local = localData([
      flight("foreflight-registered", {
        kind: "private",
        role: "pilot",
        source: "ForeFlight",
        registration: "N9900M",
      }),
    ]);
    const filters = getInitialFilters({ registration: "n9900m" });
    const map = buildMapPageContract(filters, local, null);
    const flights = buildFlightsPageContract(filters, local, null);

    expect(map.filterOptions.registrations).toEqual([
      { value: "N9900M", available: true },
    ]);
    expect(map.filteredFlightCount).toBe(1);
    expect(flights.flights).toEqual([
      expect.objectContaining({
        id: "foreflight-registered",
        registration: "N9900M",
        source: "ForeFlight",
      }),
    ]);
    expect(JSON.stringify(flights)).not.toContain("provenance");
  });

  it("preserves unknown metadata URL values as unavailable filter options", () => {
    const filters = getInitialFilters({
      aircraft: "Legacy Experimental",
      registration: "N0STALE",
    });
    const map = buildMapPageContract(filters, null, null);
    const flights = buildFlightsPageContract(filters, null, null);

    expect(map.filters).toMatchObject({
      aircraft: "Legacy Experimental",
      registration: "N0STALE",
    });
    expect(map.filterOptions.aircraft).toContainEqual({
      value: "Legacy Experimental",
      available: false,
    });
    expect(map.filterOptions.registrations).toContainEqual({
      value: "N0STALE",
      available: false,
    });
    expect(map.filteredFlightCount).toBe(0);
    expect(flights.flights).toEqual([]);
    expect(flights.filterOptions).toEqual(map.filterOptions);
    expect(serializeFiltersForHref(flights.filters)).toBe(
      "?aircraft=Legacy+Experimental&registration=N0STALE",
    );
  });

  it("includes mixed ForeFlight and FR24 aircraft values in stable searchable options", () => {
    const local = localData([
      flight("foreflight-aircraft", {
        kind: "private",
        role: "pilot",
        source: "ForeFlight",
        aircraft: "Zulu Trainer",
        aircraftType: "c172",
        aircraftModel: "Cessna 172",
        registration: "N9Z",
      }),
      flight("fr24-aircraft", {
        source: "FlightRadar24",
        aircraft: "airbus a320",
        aircraftType: "A320",
        aircraftModel: "Airbus A320",
        registration: "N1A",
      }),
    ]);
    const map = buildMapPageContract(getInitialFilters(), local, null);
    const flights = buildFlightsPageContract(getInitialFilters(), local, null);

    expect(map.filterOptions.aircraft.map(({ value }) => value)).toEqual([
      "A320",
      "Airbus A320",
      "c172",
      "Cessna 172",
      "Zulu Trainer",
    ]);
    expect(map.filterOptions.registrations.map(({ value }) => value)).toEqual([
      "N1A",
      "N9Z",
    ]);
    expect(flights.filterOptions).toEqual(map.filterOptions);
    expect(
      buildFlightsPageContract(
        getInitialFilters({ aircraft: "zulu trainer" }),
        local,
        null,
      ).flights.map(({ id }) => id),
    ).toEqual(["foreflight-aircraft"]);
  });

  it("applies metadata filters consistently to Map and Flights", () => {
    const local = localData([
      flight("registered", {
        aircraftType: "B738",
        aircraftModel: "Boeing 737-800",
        registration: "N123EX",
      }),
      flight("unregistered", { aircraftType: "A320", aircraftModel: "Airbus A320" }),
    ]);
    const filters = getInitialFilters({ aircraft: "B738", registration: "N123EX" });

    expect(buildMapPageContract(filters, local, null).filteredFlightCount).toBe(1);
    expect(buildFlightsPageContract(filters, local, null).flights.map(({ id }) => id))
      .toEqual(["registered"]);
  });

  it("preserves numeric models and removes invalid metadata from contracts", () => {
    const local = localData([
      flight("invalid", {
        aircraft: "()",
        aircraftType: "---",
        aircraftModel: "0",
        registration: "---",
      }),
      flight("numeric-model", {
        aircraft: "172",
        aircraftModel: "172",
        registration: "N172EX",
      }),
      flight("valid", {
        aircraft: "Boeing 737-800",
        aircraftType: "B738",
        aircraftModel: "Boeing 737-800",
        registration: "N123AB",
      }),
    ]);

    const map = buildMapPageContract(getInitialFilters(), local, null);
    expect(map.filterOptions.aircraft.map(({ value }) => value)).toEqual([
      "172",
      "B738",
      "Boeing 737-800",
      "Cessna 172",
      "Cessna 182",
      "Piper PA-28",
    ]);
    expect(map.filterOptions.registrations.map(({ value }) => value)).toEqual([
      "N172EX",
      "N123AB",
    ].toSorted());

    const invalid = buildFlightsPageContract(getInitialFilters(), local, null)
      .flights.find(({ id }) => id === "invalid");
    expect(invalid).toMatchObject({ aircraft: "Aircraft not specified" });
    expect(invalid).not.toHaveProperty("aircraftType");
    expect(invalid).not.toHaveProperty("aircraftModel");
    expect(invalid).not.toHaveProperty("registration");

    expect(
      buildFlightsPageContract(getInitialFilters(), local, null).flights.find(
        ({ id }) => id === "numeric-model",
      ),
    ).toMatchObject({
      aircraft: "172",
      aircraftModel: "172",
      registration: "N172EX",
    });
  });

  it("keeps Import aggregate-only", () => {
    const data = buildImportPageContract(null);
    expect(data).toEqual({
      hasLocalArtifact: false,
      normalizedFlightCount: 0,
      supportedFormats: [
        "ForeFlight Logbook",
        "myFlightradar24 Flight Diary",
        "Digital logbook CSV (MyFlightbook CSV and CrewLounge PILOTLOG compatible CSV presets, or map another CSV)",
      ],
    });
    expect(Object.keys(data)).toHaveLength(3);
  });

  it("presents role-separated personal and commercial statistics", () => {
    const map = buildMapPageContract(getInitialFilters(), null, null);
    expect(map.statsCards).toContainEqual(
      expect.objectContaining({
        label: "Role-separated time",
        secondary: "Personal hours / Commercial duration",
      }),
    );
  });
});

function flight(id: string, metadata: Partial<Flight> = {}): Flight {
  return {
    id,
    date: "2026-04-05",
    origin: airports.SEA,
    destination: airports.JFK,
    kind: "commercial",
    role: "passenger",
    aircraft: "Sanitized aircraft display",
    distanceMiles: 100,
    source: "FlightRadar24",
    ...metadata,
  };
}

function localData(flights: Flight[]): LocalFlightData {
  return {
    generatedAt: "2026-04-05T00:00:00.000Z",
    sourceLabel: "Synthetic local import",
    importedKinds: Array.from(new Set(flights.map(({ kind }) => kind))),
    stats: {
      records: flights.length,
      flights: flights.length,
      airports: 2,
      distanceMiles: flights.length * 100,
      routes: 1,
      mappedFlights: flights.length,
    },
    airports: [airports.SEA, airports.JFK],
    routes: [],
    flights,
    recentFlights: flights,
  };
}
