import type { PublicMapProjection } from "./service";

export type PublicMapFilters = {
  role: "all" | "pilot" | "passenger";
  startDate: string;
  endDate: string;
  aircraft: string;
  registration: string;
};

export const DEFAULT_PUBLIC_MAP_FILTERS: PublicMapFilters = {
  role: "all",
  startDate: "",
  endDate: "",
  aircraft: "all",
  registration: "all",
};

export type PublicMapSlice = {
  routes: PublicMapProjection["routes"];
  summary: {
    flightCount: number;
    routeCount: number;
    airportCount: number;
    countryCount: number;
  };
  filteringAvailable: boolean;
};

export function publicMapFilterOptions(projection: PublicMapProjection): {
  aircraft: string[];
  registrations: string[];
} {
  return {
    aircraft: sortedUnique(
      projection.flights.flatMap((flight) => flight.aircraft),
    ),
    registrations: sortedUnique(
      projection.flights.flatMap((flight) =>
        flight.registration ? [flight.registration] : [],
      ),
    ),
  };
}

export function derivePublicMapSlice(
  projection: PublicMapProjection,
  filters: PublicMapFilters,
): PublicMapSlice {
  const routeCounts = new Map<string, number>();
  let flightCount = 0;
  for (const flight of projection.flights) {
    if (!matchesFilters(flight, filters)) continue;
    flightCount += 1;
    for (const routeId of flight.routeIds) {
      routeCounts.set(routeId, (routeCounts.get(routeId) ?? 0) + 1);
    }
  }
  const routes = projection.routes.flatMap((route) => {
    const flightCountForRoute = routeCounts.get(route.id) ?? 0;
    return flightCountForRoute
      ? [{ ...route, flightCount: flightCountForRoute }]
      : [];
  });
  return {
    routes,
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
    filters.registration !== "all"
  );
}

function matchesFilters(
  flight: PublicMapProjection["flights"][number],
  filters: PublicMapFilters,
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
        fold(flight.registration) === fold(filters.registration)))
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
  return `${point.code}|${point.country}|${point.lat}|${point.lon}`;
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
