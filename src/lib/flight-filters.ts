import type {
  Airport,
  Flight,
  FlightKind,
  FlightSource,
  MapRoute,
} from "./flight-data";
import { aggregateRoutesFromFlights } from "./route-aggregation";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "./flight-metadata";
import type {
  RelativePeriodPreset,
  StatsPeriod,
} from "./flight-statistics";

export type FlightTypeFilter = "all" | FlightKind;
export type FlightYearFilter = "all" | number;
export type FlightMonthFilter = "all" | number;
export type FlightSourceFilter = "all" | FlightSource;
export type FlightPeriodFilter =
  | "any"
  | RelativePeriodPreset
  | "custom";

export type FlightFilters = {
  type: FlightTypeFilter;
  period: FlightPeriodFilter;
  year: FlightYearFilter;
  month: FlightMonthFilter;
  source: FlightSourceFilter;
  aircraft: string;
  registration: string;
};

export type IndexedFlight = {
  flight: Flight;
  year: number | null;
  month: number | null;
};

export type FilterOption = {
  value: number;
  available: boolean;
};

export type TextFilterOption = {
  value: string;
  available: boolean;
};

export const ALL_FLIGHT_FILTERS: FlightFilters = {
  type: "all",
  period: "any",
  year: "all",
  month: "all",
  source: "all",
  aircraft: "all",
  registration: "all",
};

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function indexFlights(flights: Flight[]): IndexedFlight[] {
  return flights.map((flight) => {
    const match = /^(\d{4})-(\d{2})-\d{2}(?:$|T)/.exec(flight.date);
    const year = match ? Number(match[1]) : null;
    const month = match ? Number(match[2]) : null;
    return {
      flight,
      year: Number.isInteger(year) ? year : null,
      month: month !== null && month >= 1 && month <= 12 ? month : null,
    };
  });
}

export function filterIndexedFlights(
  indexedFlights: IndexedFlight[],
  filters: FlightFilters,
  resolvedPeriods?: Partial<
    Record<Exclude<FlightPeriodFilter, "any">, StatsPeriod>
  >,
): Flight[] {
  return indexedFlights
    .filter((entry) =>
      matchesFlightFilters(entry, filters, resolvedPeriods),
    )
    .map(({ flight }) => flight);
}

export function aggregateFlightRoutes(flights: Flight[]): MapRoute[] {
  return aggregateRoutesFromFlights(flights);
}

export function airportsForFilteredRoutes(routes: MapRoute[]): Airport[] {
  return Array.from(
    new Map(
      routes
        .flatMap((route) => [route.origin, route.destination])
        .map((airport) => [airport.code, airport]),
    ).values(),
  );
}

export function getFilterOptions(
  indexedFlights: IndexedFlight[],
  filters: FlightFilters,
  resolvedPeriods?: Partial<
    Record<Exclude<FlightPeriodFilter, "any">, StatsPeriod>
  >,
): {
  years: FilterOption[];
  months: FilterOption[];
  sources: TextFilterOption[];
  aircraft: TextFilterOption[];
  registrations: TextFilterOption[];
} {
  const years = Array.from(
    new Set(
      indexedFlights
        .map(({ year }) => year)
        .filter((year): year is number => year !== null),
    ),
  )
    .sort((left, right) => right - left)
    .map((year) => ({
      value: year,
      available: indexedFlights.some(
        (entry) =>
          entry.year === year &&
          matchesFlightFilters(entry, {
            ...filters,
            period: "custom",
            year: "all",
            month: "all",
          }),
      ),
    }));

  const months = MONTH_NAMES.map((_, index) => {
    const month = index + 1;
    return {
      value: month,
      available: indexedFlights.some(
        (entry) =>
          entry.month === month &&
          matchesFlightFilters(entry, {
            ...filters,
            period: "custom",
            month: "all",
          }),
      ),
    };
  });
  const sources = sourceFilterOptions(
    indexedFlights,
    filters,
    resolvedPeriods,
  );

  const aircraft = textFilterOptions(
    indexedFlights,
    filters,
    "aircraft",
    resolvedPeriods,
  );
  const registrations = textFilterOptions(
    indexedFlights,
    filters,
    "registration",
    resolvedPeriods,
  );

  return { years, months, sources, aircraft, registrations };
}

export function hasActiveFlightFilters(filters: FlightFilters): boolean {
  return (
    filters.type !== "all" ||
    filters.period !== "any" ||
    filters.source !== "all" ||
    filters.aircraft !== "all" ||
    filters.registration !== "all"
  );
}

function matchesFlightFilters(
  entry: IndexedFlight,
  filters: FlightFilters,
  resolvedPeriods?: Partial<
    Record<Exclude<FlightPeriodFilter, "any">, StatsPeriod>
  >,
  ignoredFilter?: "aircraft" | "registration" | "source",
): boolean {
  const resolvedPeriod =
    filters.period === "any" ? undefined : resolvedPeriods?.[filters.period];
  const dateMatches =
    filters.period === "any" ||
    (resolvedPeriod
      ? entry.flight.date >= resolvedPeriod.startDate &&
        entry.flight.date < resolvedPeriod.endDateExclusive
      : filters.period === "custom"
      ? (filters.year === "all" || entry.year === filters.year) &&
        (filters.month === "all" || entry.month === filters.month)
      : false);
  return (
    (filters.type === "all" || entry.flight.kind === filters.type) &&
    dateMatches &&
    (ignoredFilter === "source" ||
      filters.source === "all" ||
      entry.flight.source === filters.source) &&
    (ignoredFilter === "aircraft" ||
      filters.aircraft === "all" ||
      metadataValues(entry.flight, "aircraft").some(
        (value) =>
          value.toLocaleLowerCase("en-US") ===
          filters.aircraft.toLocaleLowerCase("en-US"),
      )) &&
    (ignoredFilter === "registration" ||
      filters.registration === "all" ||
      metadataValues(entry.flight, "registration").some(
        (value) =>
          value.toLocaleLowerCase("en-US") ===
          filters.registration.toLocaleLowerCase("en-US"),
      ))
  );
}

function sourceFilterOptions(
  indexedFlights: IndexedFlight[],
  filters: FlightFilters,
  resolvedPeriods?: Partial<
    Record<Exclude<FlightPeriodFilter, "any">, StatsPeriod>
  >,
): TextFilterOption[] {
  return Array.from(
    new Set(indexedFlights.map(({ flight }) => flight.source)),
  )
    .toSorted(compareFilterText)
    .map((value) => ({
      value,
      available: indexedFlights.some(
        (entry) =>
          entry.flight.source === value &&
          matchesFlightFilters(entry, filters, resolvedPeriods, "source"),
      ),
    }));
}

export function normalizeFlightSourceFilter(
  value: string | null | undefined,
): FlightSourceFilter {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized === "all") return "all";
  if (normalized === "foreflight") return "ForeFlight";
  if (
    normalized === "flightradar24" ||
    normalized === "fr24" ||
    normalized === "myflightradar24"
  ) {
    return "FlightRadar24";
  }
  if (normalized === "csv") return "CSV";
  if (normalized === "manual") return "Manual";
  return "all";
}

function metadataValues(
  flight: Flight,
  field: "aircraft" | "registration",
): string[] {
  const values =
    field === "aircraft"
      ? [flight.aircraftType, flight.aircraftModel, flight.aircraft]
      : [flight.registration];
  return values.flatMap((value) => {
    const normalized =
      field === "aircraft"
        ? normalizeAircraftMetadata(value)
        : normalizeRegistrationMetadata(value);
    return normalized ? [normalized] : [];
  });
}

function textFilterOptions(
  indexedFlights: IndexedFlight[],
  filters: FlightFilters,
  field: "aircraft" | "registration",
  resolvedPeriods?: Partial<
    Record<Exclude<FlightPeriodFilter, "any">, StatsPeriod>
  >,
): TextFilterOption[] {
  const valuesByFoldedName = new Map<string, string>();
  for (const { flight } of indexedFlights) {
    for (const value of metadataValues(flight, field)) {
      const folded = value.toLocaleLowerCase("en-US");
      if (!valuesByFoldedName.has(folded)) valuesByFoldedName.set(folded, value);
    }
  }
  const selected = filters[field];
  const normalizedSelected =
    field === "aircraft"
      ? normalizeAircraftMetadata(selected)
      : normalizeRegistrationMetadata(selected);
  if (selected !== "all" && normalizedSelected) {
    const foldedSelected = normalizedSelected.toLocaleLowerCase("en-US");
    if (!valuesByFoldedName.has(foldedSelected)) {
      valuesByFoldedName.set(foldedSelected, normalizedSelected);
    }
  }
  const allValues = [...valuesByFoldedName.values()].toSorted(compareFilterText);
  return allValues.map((value) => ({
    value,
    available: indexedFlights.some(
      (entry) =>
        metadataValues(entry.flight, field).some(
          (candidate) =>
            candidate.toLocaleLowerCase("en-US") ===
            value.toLocaleLowerCase("en-US"),
        ) && matchesFlightFilters(entry, filters, resolvedPeriods, field),
    ),
  }));
}

function compareFilterText(left: string, right: string): number {
  return (
    left.localeCompare(right, "en-US", {
    sensitivity: "base",
    numeric: true,
    }) ||
    left.localeCompare(right, "en-US", {
    sensitivity: "variant",
    numeric: true,
    })
  );
}
