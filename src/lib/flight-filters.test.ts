import { describe, expect, it } from "vitest";
import { airports, type Flight } from "./flight-data";
import {
  aggregateFlightRoutes,
  ALL_FLIGHT_FILTERS,
  filterIndexedFlights,
  getFilterOptions,
  indexFlights,
  type FlightFilters,
} from "./flight-filters";

const syntheticFlights: Flight[] = [
  flight("personal-january", "2025-01-05", "private", "pilot", "PAE", "SEA"),
  flight("personal-february", "2025-02-08", "private", "pilot", "PAE", "SEA"),
  flight("commercial-january-a", "2025-01-12", "commercial", "passenger", "SEA", "JFK"),
  flight("commercial-january-b", "2025-01-19", "commercial", "passenger", "SEA", "JFK"),
  flight("commercial-march", "2024-03-03", "commercial", "passenger", "JFK", "SEA"),
];

describe("flight map filters", () => {
  const indexed = indexFlights(syntheticFlights);

  it("combines type, year, and month with AND semantics", () => {
    const filters: FlightFilters = {
      ...ALL_FLIGHT_FILTERS,
      type: "commercial",
      period: "custom",
      year: 2025,
      month: 1,
    };

    expect(filterIndexedFlights(indexed, filters).map(({ id }) => id)).toEqual([
      "commercial-january-a",
      "commercial-january-b",
    ]);
    expect(
      filterIndexedFlights(indexed, { ...filters, type: "private" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["personal-january"]);
  });

  it("recomputes exact route frequency from only the filtered flights", () => {
    const januaryCommercial = filterIndexedFlights(indexed, {
      ...ALL_FLIGHT_FILTERS,
      type: "commercial",
      period: "custom",
      year: 2025,
      month: 1,
    });

    const routes = aggregateFlightRoutes(januaryCommercial);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ kind: "commercial", flightCount: 2 });
    expect([routes[0].origin.code, routes[0].destination.code].sort()).toEqual([
      "JFK",
      "SEA",
    ]);
  });

  it("aggregates opposite directions into one route with per-direction counts", () => {
    const routes = aggregateFlightRoutes(syntheticFlights);
    const commercial = routes.find(({ kind }) => kind === "commercial")!;

    expect(routes).toHaveLength(2);
    expect(commercial.flightCount).toBe(3);
    expect(
      [commercial.forwardFlightCount, commercial.reverseFlightCount].sort(),
    ).toEqual([1, 2]);
  });

  it("reports years present and month availability for the active type and year", () => {
    const options = getFilterOptions(indexed, {
      ...ALL_FLIGHT_FILTERS,
      type: "private",
      period: "custom",
      year: 2025,
      month: "all",
    });

    expect(options.years.map(({ value }) => value)).toEqual([2025, 2024]);
    expect(options.years.find(({ value }) => value === 2024)?.available).toBe(false);
    expect(options.months.filter(({ available }) => available).map(({ value }) => value))
      .toEqual([1, 2]);
  });

  it("returns an empty slice for an unavailable AND combination", () => {
    expect(
      filterIndexedFlights(indexed, {
        ...ALL_FLIGHT_FILTERS,
        type: "private",
        period: "custom",
        year: 2024,
        month: 3,
      }),
    ).toEqual([]);
  });

  it("uses server-resolved civil-date ranges for relative shortcuts", () => {
    const thisYear = {
      preset: "this-year" as const,
      startDate: "2025-01-01" as const,
      endDateExclusive: "2025-02-01" as const,
      elapsedDays: 31,
      isPartial: true,
    };

    expect(
      filterIndexedFlights(
        indexed,
        {
          ...ALL_FLIGHT_FILTERS,
          type: "commercial",
          period: "this-year",
          year: "all",
          month: "all",
        },
        { "this-year": thisYear },
      ).map(({ id }) => id),
    ).toEqual(["commercial-january-a", "commercial-january-b"]);
  });

  it("filters by canonical import source and reports source availability", () => {
    const filters = {
      ...ALL_FLIGHT_FILTERS,
      source: "ForeFlight" as const,
    };

    expect(
      filterIndexedFlights(indexed, filters).map(({ id }) => id),
    ).toEqual(["personal-january", "personal-february"]);
    expect(getFilterOptions(indexed, filters).sources).toEqual([
      { value: "FlightRadar24", available: true },
      { value: "ForeFlight", available: true },
    ]);
  });

  it("filters exact explicit aircraft metadata without matching missing values", () => {
    const flights = [
      flight(
        "typed-registered",
        "2025-01-05",
        "commercial",
        "passenger",
        "SEA",
        "JFK",
        { aircraftType: "B738", aircraftModel: "Boeing 737-800", registration: "N123EX" },
      ),
      flight(
        "typed-only",
        "2025-01-06",
        "private",
        "pilot",
        "PAE",
        "SEA",
        { aircraftType: "C172", aircraftModel: "Cessna 172" },
      ),
      flight("missing-metadata", "2025-01-07", "commercial", "passenger", "SEA", "JFK"),
    ];

    expect(
      filterIndexedFlights(indexFlights(flights), {
        ...ALL_FLIGHT_FILTERS,
        aircraft: "B738",
        registration: "n123ex",
      }).map(({ id }) => id),
    ).toEqual(["typed-registered"]);
    expect(
      filterIndexedFlights(indexFlights(flights), {
        ...ALL_FLIGHT_FILTERS,
        registration: "N000XX",
      }),
    ).toEqual([]);
  });

  it("derives only truthful metadata options across mixed sources", () => {
    const flights = [
      flight(
        "fr24",
        "2025-01-05",
        "commercial",
        "passenger",
        "SEA",
        "JFK",
        { aircraftType: "B738", aircraftModel: "Boeing 737-800", registration: "N123EX" },
      ),
      flight(
        "foreflight",
        "2025-01-06",
        "private",
        "pilot",
        "PAE",
        "SEA",
        { aircraftType: "C172", aircraftModel: "Cessna 172" },
      ),
      flight("csv-without-metadata", "2025-01-07", "commercial", "passenger", "SEA", "JFK"),
    ];
    const options = getFilterOptions(indexFlights(flights), ALL_FLIGHT_FILTERS);

    expect(options.aircraft.map(({ value }) => value)).toEqual([
      "B738",
      "Boeing 737-800",
      "C172",
      "Cessna 172",
      "Synthetic test aircraft",
    ]);
    expect(options.registrations.map(({ value }) => value)).toEqual(["N123EX"]);
  });

  it("keeps numeric models while rejecting placeholder metadata", () => {
    const flights = [
      flight(
        "valid",
        "2025-01-05",
        "commercial",
        "passenger",
        "SEA",
        "JFK",
        {
          aircraftType: "B738",
          aircraftModel: "Boeing 737-800",
          registration: "N123AB",
        },
      ),
      flight(
        "numeric-model",
        "2025-01-06",
        "commercial",
        "passenger",
        "SEA",
        "JFK",
        { aircraftModel: "172", registration: "0" },
      ),
      flight(
        "sentinels",
        "2025-01-07",
        "commercial",
        "passenger",
        "SEA",
        "JFK",
        { aircraftType: "N/A", aircraftModel: "---", registration: "()" },
      ),
    ];
    const options = getFilterOptions(indexFlights(flights), {
      ...ALL_FLIGHT_FILTERS,
      aircraft: "172",
      registration: "0",
    });

    expect(options.aircraft.map(({ value }) => value)).toEqual([
      "172",
      "B738",
      "Boeing 737-800",
      "Synthetic test aircraft",
    ]);
    expect(options.registrations.map(({ value }) => value)).toEqual(["N123AB"]);
  });
});

function flight(
  id: string,
  date: string,
  kind: Flight["kind"],
  role: Flight["role"],
  origin: keyof typeof airports,
  destination: keyof typeof airports,
  metadata: Pick<Flight, "aircraftType" | "aircraftModel" | "registration"> = {},
): Flight {
  return {
    id,
    date,
    origin: airports[origin],
    destination: airports[destination],
    kind,
    role,
    aircraft: "Synthetic test aircraft",
    ...metadata,
    distanceMiles: 100,
    source: kind === "private" ? "ForeFlight" : "FlightRadar24",
  };
}
