// Serializable flight filter state for URL persistence
import {
  ALL_FLIGHT_FILTERS,
  normalizeFlightSourceFilter,
  type FlightFilters,
} from "./flight-filters";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "./flight-metadata";

export function serializeFilters(filters: FlightFilters): string {
  const params = new URLSearchParams();
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.period !== "any") params.set("period", filters.period);
  if (filters.year !== "all") params.set("year", String(filters.year));
  if (filters.month !== "all") params.set("month", String(filters.month));
  if (filters.source !== "all") params.set("source", filters.source);
  if (filters.aircraft && filters.aircraft !== "all") {
    params.set("aircraft", filters.aircraft);
  }
  if (filters.registration && filters.registration !== "all") {
    params.set("registration", filters.registration);
  }
  return params.toString();
}

export function deserializeFilters(queryString: string): FlightFilters {
  const params = new URLSearchParams(queryString);
  const filters = { ...ALL_FLIGHT_FILTERS };

  const type = params.get("type");
  if (type && (type === "private" || type === "commercial")) {
    filters.type = type;
  }

  const period = params.get("period");
  if (
    period &&
    (period === "this-year" ||
      period === "last-year" ||
      period === "this-month" ||
      period === "last-month" ||
      period === "custom")
  ) {
    filters.period = period;
  }

  const year = params.get("year");
  if (year && year !== "all") {
    const parsed = Number(year);
    if (!Number.isNaN(parsed)) filters.year = parsed;
  }

  const month = params.get("month");
  if (month && month !== "all") {
    const parsed = Number(month);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 12) {
      filters.month = parsed;
    }
  }

  filters.source = normalizeFlightSourceFilter(params.get("source"));

  const aircraft = normalizeAircraftMetadata(params.get("aircraft"));
  if (aircraft) {
    filters.aircraft = aircraft;
  }

  const registration = normalizeRegistrationMetadata(
    params.get("registration"),
  );
  if (registration) {
    filters.registration = registration;
  }

  return filters;
}
