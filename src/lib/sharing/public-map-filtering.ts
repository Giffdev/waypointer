import type { PublicMapProjection } from "./service";
import {
  airportExactIdentity,
  deriveRouteDirectionMode,
} from "@/lib/flight-data";

export type PublicMapFilters = {
  role: "all" | "pilot" | "passenger";
  startDate: string;
  endDate: string;
  aircraft: string;
  registration: string;
  airport: string;
};

export const DEFAULT_PUBLIC_MAP_FILTERS: PublicMapFilters = {
  role: "all",
  startDate: "",
  endDate: "",
  aircraft: "all",
  registration: "all",
  airport: "all",
};

export type PublicAirportFilterOption = {
  value: string;
  label: string;
  searchText: string;
  available: boolean;
};

export type PublicMapSlice = {
  routes: PublicMapProjection["routes"];
  /**
   * Filtered flights that carry an overflown path, in projection order.
   * Presentation only — `routes` and `summary` never read it.
   */
  routePathFlights: PublicMapProjection["flights"];
  summary: {
    flightCount: number;
    routeCount: number;
    airportCount: number;
    countryCount: number;
  };
  filteringAvailable: boolean;
};

export function publicMapFilterOptions(projection: PublicMapProjection): {
  aircraft: Array<{ value: string; available: boolean }>;
  registrations: Array<{ value: string; available: boolean }>;
  airports: PublicAirportFilterOption[];
} {
  return {
    aircraft: sortedUnique(
      projection.flights.flatMap((flight) => flight.aircraft),
    ).map((value) => ({ value, available: true })),
    registrations: sortedUnique(
      projection.flights.flatMap((flight) =>
        flight.registration ? [flight.registration] : [],
      ),
    ).map((value) => ({ value, available: true })),
    airports: publicAirportOptions(projection).map((option) => ({
      ...option,
      available: true,
    })),
  };
}

export function publicMapFilterOptionsForFilters(
  projection: PublicMapProjection,
  filters: PublicMapFilters,
): {
  aircraft: Array<{ value: string; available: boolean }>;
  registrations: Array<{ value: string; available: boolean }>;
  airports: PublicAirportFilterOption[];
} {
  const options = publicMapFilterOptions(projection);
  const routeAirportKeys = routeAirportKeysById(projection);
  const aircraftFilters = { ...filters, aircraft: "all" };
  const registrationFilters = { ...filters, registration: "all" };
  const airportFilters = { ...filters, airport: "all" };
  const availableAircraft = new Set<string>();
  const availableRegistrations = new Set<string>();
  const availableAirports = new Set<string>();
  for (const flight of projection.flights) {
    if (matchesFilters(flight, aircraftFilters, routeAirportKeys)) {
      for (const value of flight.aircraft) {
        availableAircraft.add(fold(value));
      }
    }
    if (
      flight.registration &&
      matchesFilters(flight, registrationFilters, routeAirportKeys)
    ) {
      availableRegistrations.add(fold(flight.registration));
    }
    if (matchesFilters(flight, airportFilters, routeAirportKeys)) {
      for (const { routeId } of flight.routeLegs) {
        for (const airportKey of routeAirportKeys.get(routeId) ?? []) {
          availableAirports.add(airportKey);
        }
      }
    }
  }
  return {
    aircraft: options.aircraft.map(({ value }) => ({
      value,
      available: availableAircraft.has(fold(value)),
    })),
    registrations: options.registrations.map(({ value }) => ({
      value,
      available: availableRegistrations.has(fold(value)),
    })),
    airports: options.airports.map((option) => ({
      ...option,
      available: availableAirports.has(option.value),
    })),
  };
}

export function derivePublicMapSlice(
  projection: PublicMapProjection,
  filters: PublicMapFilters,
): PublicMapSlice {
  const routeAirportKeys = routeAirportKeysById(projection);
  const routeCounts = new Map<
    string,
    { flightCount: number; forward: number; reverse: number }
  >();
  let flightCount = 0;
  const routePathFlights: PublicMapProjection["flights"] = [];
  for (const flight of projection.flights) {
    if (!matchesFilters(flight, filters, routeAirportKeys)) continue;
    flightCount += 1;
    if (flight.routePath) routePathFlights.push(flight);
    for (const { routeId, direction } of flight.routeLegs) {
      const counts = routeCounts.get(routeId) ?? {
        flightCount: 0,
        forward: 0,
        reverse: 0,
      };
      counts.flightCount += 1;
      if (direction === "forward") counts.forward += 1;
      if (direction === "reverse") counts.reverse += 1;
      routeCounts.set(routeId, counts);
    }
  }
  const routes = projection.routes.flatMap((route) => {
    const counts = routeCounts.get(route.id);
    return counts
      ? [{
          ...route,
          flightCount: counts.flightCount,
          forwardFlightCount: counts.forward,
          reverseFlightCount: counts.reverse,
          directionMode: deriveRouteDirectionMode(
            counts.forward,
            counts.reverse,
            publicAirportKey(route.origin) ===
              publicAirportKey(route.destination),
          ),
        }]
      : [];
  });
  return {
    routes,
    routePathFlights,
    summary: summarizeRoutes(routes, flightCount),
    filteringAvailable: true,
  };
}

export function hasActivePublicMapFilters(
  filters: PublicMapFilters,
): boolean {
  return (
    filters.role !== "all" ||
    Boolean(filters.startDate) ||
    Boolean(filters.endDate) ||
    filters.aircraft !== "all" ||
    filters.registration !== "all" ||
    filters.airport !== "all"
  );
}

function matchesFilters(
  flight: PublicMapProjection["flights"][number],
  filters: PublicMapFilters,
  routeAirportKeys: ReadonlyMap<string, readonly string[]>,
): boolean {
  return (
    (filters.role === "all" || flight.role === filters.role) &&
    (!filters.startDate || flight.date >= filters.startDate) &&
    (!filters.endDate || flight.date <= filters.endDate) &&
    (filters.aircraft === "all" ||
      flight.aircraft.some(
        (value) => fold(value) === fold(filters.aircraft),
      )) &&
    (filters.registration === "all" ||
      (flight.registration !== null &&
        fold(flight.registration) === fold(filters.registration))) &&
    (filters.airport === "all" ||
      flight.routeLegs.some(({ routeId }) =>
        routeAirportKeys.get(routeId)?.includes(filters.airport),
      ))
  );
}

function publicAirportOptions(
  projection: PublicMapProjection,
): Omit<PublicAirportFilterOption, "available">[] {
  const options = new Map<
    string,
    Omit<PublicAirportFilterOption, "available">
  >();
  for (const route of projection.routes) {
    for (const airport of [route.origin, route.destination]) {
      const value = publicAirportKey(airport);
      if (!options.has(value)) {
        options.set(value, {
          value,
          label: `${airport.code} — ${airport.name}, ${airport.city}`,
          searchText: `${airport.code} ${airport.name} ${airport.city} ${airport.country}`,
        });
      }
    }
  }
  return [...options.values()].toSorted((left, right) =>
    left.label.localeCompare(right.label, "en-US", {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

function routeAirportKeysById(
  projection: PublicMapProjection,
): Map<string, readonly string[]> {
  return new Map(
    projection.routes.map((route) => [
      route.id,
      [publicAirportKey(route.origin), publicAirportKey(route.destination)],
    ]),
  );
}

function summarizeRoutes(
  routes: PublicMapProjection["routes"],
  flightCount: number,
): PublicMapSlice["summary"] {
  const airports = new Set<string>();
  const countries = new Set<string>();
  const visibleRoutes = new Set<string>();
  for (const route of routes) {
    for (const point of [route.origin, route.destination]) {
      airports.add(publicAirportKey(point));
      countries.add(point.country);
    }
    const endpoints = [route.origin, route.destination]
      .map(
        (point) =>
          publicAirportKey(point),
      )
      .sort();
    visibleRoutes.add(`${route.kind}|${endpoints.join("|")}`);
  }
  return {
    flightCount,
    routeCount: visibleRoutes.size,
    airportCount: airports.size,
    countryCount: countries.size,
  };
}

function publicAirportKey(
  point: PublicMapProjection["routes"][number]["origin"],
): string {
  return airportExactIdentity(point);
}

function sortedUnique(values: string[]): string[] {
  const valuesByFoldedName = new Map<string, string>();
  for (const value of values) {
    const folded = fold(value);
    if (!valuesByFoldedName.has(folded)) {
      valuesByFoldedName.set(folded, value);
    }
  }
  return [...valuesByFoldedName.values()].toSorted((left, right) =>
    left.localeCompare(right, "en-US", {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

function fold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}
