import {
  aggregateFlightRoutes,
  ALL_FLIGHT_FILTERS,
  filterIndexedFlights,
  getFilterOptions,
  hasActiveFlightFilters,
  indexFlights,
  MONTH_NAMES,
  normalizeFlightSourceFilter,
  type FlightFilters,
  type FlightPeriodFilter,
  type FlightSourceFilter,
  type FlightTypeFilter,
  type IndexedFlight,
} from "@/lib/flight-filters";
import {
  aggregateStatsSlice,
  resolveStatsPeriod,
  type AggregateMetric,
  type StatsFilters,
  type StatsMetricSet,
  type StatsSlice,
} from "@/lib/flight-statistics";
import {
  airportsForRoutes,
  mergeFlightCollections,
  sampleFlights,
  uniqueAirports,
} from "@/lib/flight-data";
import type { LocalFlightData } from "@/lib/local-flight-data";
import type { LocalFlightStatisticsContext } from "@/lib/local-flight-statistics";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "@/lib/flight-metadata";
import {
  busiestDirectionalRoute,
  formatCivilDateLabel,
  formatComparisonBasis,
  formatComparisonDelta,
  formatPeriodRange,
  resolveInsightsPeriods,
  statsFactsFromFlights,
  type RelativePeriodMap,
} from "@/lib/flight-insights";
import { deriveInitialMapFrame } from "@/lib/map-framing";
import {
  DEFAULT_DISTANCE_UNIT,
  formatDistanceForUnit,
  type DistanceUnit,
} from "@/lib/distance-unit";

export type SharedFlightData = ReturnType<typeof createSharedFlightData>;
export type FlightFiltersInput = Omit<
  FlightFilters,
  "source" | "aircraft" | "registration"
> &
  Partial<Pick<FlightFilters, "source" | "aircraft" | "registration">>;
export type StatsCard = {
  label: string;
  value: string;
  secondary?: string;
  delta?: string | null;
  description?: string;
};

export const flightTypeLabels: Record<FlightTypeFilter, string> = {
  all: "All flights",
  private: "Personal / Pilot",
  commercial: "Commercial / Passenger",
};

export const periodLabels: Record<FlightPeriodFilter, string> = {
  any: "Any period",
  "this-year": "This Year",
  "last-year": "Last Year",
  "this-month": "This Month",
  "last-month": "Last Month",
  custom: "Custom",
};

export const flightSourceLabels: Record<FlightSourceFilter, string> = {
  all: "All import sources",
  ForeFlight: "ForeFlight",
  FlightRadar24: "FlightRadar24",
  CSV: "CSV",
  Manual: "Manual entry",
};

export const quickPeriods: FlightPeriodFilter[] = ["any", "this-month", "last-month", "this-year", "last-year", "custom"];

export function createSharedFlightData(localData: LocalFlightData | null, statisticsContext?: LocalFlightStatisticsContext | null) {
  const authoritative = localData?.authoritative === true;
  const displayFlights = authoritative
    ? localData.flights
    : mergeFlightCollections(sampleFlights, localData?.flights, localData?.importedKinds);
  const indexedFlights = indexFlights(displayFlights);
  const fallbackDate = displayFlights.map((flight) => flight.date.slice(0, 10)).toSorted().at(-1) ?? "2026-01-01";
  const stableStatisticsContext: LocalFlightStatisticsContext = statisticsContext ?? {
    facts: [],
    asOfDate: fallbackDate as LocalFlightStatisticsContext["asOfDate"],
    timeZone: "UTC",
  };
  const relativePeriods = Object.fromEntries((["this-year", "last-year", "this-month", "last-month"] as const).map((period) => [period, resolveStatsPeriod({ period, asOfDate: stableStatisticsContext.asOfDate, timeZone: stableStatisticsContext.timeZone })])) as RelativePeriodMap;
  const importedKinds = new Set(localData?.importedKinds ?? []);
  const representativeFacts = authoritative
    ? []
    : statsFactsFromFlights(sampleFlights.filter((flight) => !importedKinds.has(flight.kind)));
  const statisticsFacts = [...stableStatisticsContext.facts, ...representativeFacts];
  const allHistoryRoutes = aggregateFlightRoutes(displayFlights);
  const importedAirports = localData?.airports;
  const displayAirports =
    authoritative
      ? Array.from(new Map([...airportsForRoutes(allHistoryRoutes), ...(importedAirports ?? [])].map((airport) => [airport.code, airport])).values())
      : !importedAirports?.length
        ? uniqueAirports
        : Array.from(new Map([...airportsForRoutes(allHistoryRoutes), ...importedAirports].map((airport) => [airport.code, airport])).values());
  const homeFrame = deriveInitialMapFrame(allHistoryRoutes);
  return { localData, displayFlights, indexedFlights, stableStatisticsContext, relativePeriods, statisticsFacts, allHistoryRoutes, displayAirports, homeFrame };
}

export function buildRouteScopedView(
  shared: SharedFlightData,
  filters: FlightFilters,
  distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT,
) {
  const insightsPeriods = resolveInsightsPeriods(filters, shared.statisticsFacts, shared.relativePeriods, shared.stableStatisticsContext.asOfDate);
  const resolvedPrimaryPeriods = { ...Object.fromEntries(Object.entries(shared.relativePeriods).map(([preset, resolved]) => [preset, resolved.primary])), ...(filters.period === "custom" ? { custom: insightsPeriods.primary } : {}) };
  const filteredFlights = filterIndexedFlights(shared.indexedFlights, filters, resolvedPrimaryPeriods);
  const filteredRoutes = aggregateFlightRoutes(filteredFlights);
  const activeAirportCodes = new Set(filteredRoutes.flatMap((route) => [route.origin.code, route.destination.code]));
  const filterOptions = getFilterOptions(
    shared.indexedFlights,
    filters,
    resolvedPrimaryPeriods,
  );
  const statsFilters: StatsFilters = {
    kind: filters.type,
    activities: ["flight"],
    ...(filters.source === "all" ? {} : { sources: [filters.source] }),
  };
  const metadataFiltered = filters.aircraft !== "all" || filters.registration !== "all";
  const metadataFlightIds = new Set(
    filterIndexedFlights(shared.indexedFlights, {
      ...filters,
      period: "any",
      year: "all",
      month: "all",
    }).map((flight) => flight.id),
  );
  const statisticsFacts = metadataFiltered
    ? shared.statisticsFacts.filter((fact) => metadataFlightIds.has(fact.id))
    : shared.statisticsFacts;
  const primaryStats = aggregateStatsSlice(statisticsFacts, insightsPeriods.primary, statsFilters);
  const comparisonStats = insightsPeriods.comparison ? aggregateStatsSlice(statisticsFacts, insightsPeriods.comparison, statsFilters) : null;
  const busiestRoute = busiestDirectionalRoute(filteredRoutes);
  const statsCards = buildStatsCards(filters.type, primaryStats.metrics, primaryStats.byRole, comparisonStats, activeAirportCodes.size, distanceUnit);
  const completenessText = buildCompletenessText(filters.type, primaryStats.metrics, primaryStats.byRole, distanceUnit);
  const visibleFlights = filteredFlights.toSorted((left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id));
  return { insightsPeriods, filteredFlights, filteredRoutes, activeAirportCodes, filterOptions, primaryStats, comparisonStats, busiestRoute, statsCards, completenessText, visibleFlights };
}

export function findLatestYearForMonth(indexedFlights: IndexedFlight[], filters: FlightFilters, month: number): number | "all" {
  return filterIndexedFlights(
    indexedFlights,
    { ...filters, period: "custom", year: "all", month },
  ).map((flight) => Number(flight.date.slice(0, 4))).filter(Number.isInteger).toSorted((left, right) => right - left)[0] ?? "all";
}

export function formatFlightDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function serializeFiltersForHref(filters: FlightFiltersInput) {
  const normalized = normalizeFlightFilters(filters);
  const params = new URLSearchParams();
  if (normalized.type !== "all") params.set("type", normalized.type);
  if (normalized.period !== "any") params.set("period", normalized.period);
  if (normalized.year !== "all") params.set("year", String(normalized.year));
  if (normalized.month !== "all") params.set("month", String(normalized.month));
  if (normalized.source !== "all") params.set("source", normalized.source);
  if (normalized.aircraft !== "all") params.set("aircraft", normalized.aircraft);
  if (normalized.registration !== "all") {
    params.set("registration", normalized.registration);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getInitialFilters(searchParams?: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item);
      else if (value != null) params.set(key, value);
    }
  }
  const filters = { ...ALL_FLIGHT_FILTERS };
  const type = params.get("type");
  if (type === "private" || type === "commercial") filters.type = type;
  const period = params.get("period");
  if (period === "this-year" || period === "last-year" || period === "this-month" || period === "last-month" || period === "custom") filters.period = period;
  const year = params.get("year");
  if (year && year !== "all") {
    const parsed = Number(year);
    if (Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2200) {
      filters.year = parsed;
    }
  }
  const month = params.get("month");
  if (month && month !== "all") {
    const parsed = Number(month);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 12) filters.month = parsed;
  }
  filters.source = normalizeFlightSourceFilter(params.get("source"));
  filters.aircraft = parseMetadataFilter(params.get("aircraft"), "aircraft");
  filters.registration = parseMetadataFilter(
    params.get("registration"),
    "registration",
  );
  if (
    filters.period === "any" &&
    (filters.year !== "all" || filters.month !== "all")
  ) {
    filters.period = "custom";
  }
  return normalizeFlightFilters(filters);
}

export function normalizeFlightFilters(
  filters: FlightFiltersInput,
): FlightFilters {
  const normalized: FlightFilters = {
    ...ALL_FLIGHT_FILTERS,
    ...filters,
    source: normalizeFlightSourceFilter(filters.source),
    aircraft: parseMetadataFilter(filters.aircraft, "aircraft"),
    registration: parseMetadataFilter(filters.registration, "registration"),
  };
  if (normalized.period !== "custom") {
    return { ...normalized, year: "all", month: "all" };
  }
  return normalized;
}

function parseMetadataFilter(
  value: string | null | undefined,
  field: "aircraft" | "registration",
): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.toLocaleLowerCase() === "all"
  ) {
    return "all";
  }
  return (
    field === "aircraft"
      ? normalizeAircraftMetadata(normalized)
      : normalizeRegistrationMetadata(normalized)
  ) ?? "all";
}

export function buildStatsCards(type: FlightTypeFilter, metrics: StatsMetricSet, byRole: StatsSlice["byRole"], comparison: StatsSlice | null, activeAirportCount: number, distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT): StatsCard[] {
  if (type === "private") return [metricCard("Flights", metrics.flights, comparison?.metrics.flights, distanceUnit), { ...metricCard("TotalTime", byRole.pilot.durationHours, comparison?.byRole.pilot.durationHours, distanceUnit), secondary: byRole.pilot.hobbsHours.value === null ? "Hobbs elapsed —" : `Hobbs elapsed ${formatMetric(byRole.pilot.hobbsHours, distanceUnit)} · not a cumulative meter` }, { label: "Mapped airports", value: activeAirportCount.toLocaleString(), secondary: "Active in this filter" }, metricCard("Distance", metrics.distanceMiles, comparison?.metrics.distanceMiles, distanceUnit)];
  if (type === "commercial") return [metricCard("Flights", metrics.flights, comparison?.metrics.flights, distanceUnit), metricCard("Duration", byRole.passenger.durationHours, comparison?.byRole.passenger.durationHours, distanceUnit), metricCard("Distance", metrics.distanceMiles, comparison?.metrics.distanceMiles, distanceUnit), { label: "Mapped airports", value: activeAirportCount.toLocaleString(), secondary: "Active in this filter" }];
  const personal = byRole.pilot.durationHours;
  const commercial = byRole.passenger.durationHours;
  const personalComparison = comparison?.byRole.pilot.durationHours;
  const commercialComparison = comparison?.byRole.passenger.durationHours;
  const timeDeltas = [prefixDelta("Personal", personal, personalComparison), prefixDelta("Commercial", commercial, commercialComparison)].filter(Boolean);
  return [metricCard("Flight records", metrics.flights, comparison?.metrics.flights, distanceUnit), { label: "Mapped airports", value: activeAirportCount.toLocaleString(), secondary: "Active in this filter" }, metricCard("Distance", metrics.distanceMiles, comparison?.metrics.distanceMiles, distanceUnit), { label: "Role-separated time", value: `${formatMetric(personal, distanceUnit)} / ${formatMetric(commercial, distanceUnit)}`, secondary: "Personal hours / Commercial duration", delta: timeDeltas.length ? timeDeltas.join(" · ") : null }];
}

function metricCard(label: string, metric: AggregateMetric, comparison: AggregateMetric | undefined, distanceUnit: DistanceUnit): StatsCard {
  return { label, value: formatMetric(metric, distanceUnit), description: metric.unit === "miles" ? distanceBasisDisclosure(metric, distanceUnit) : undefined, delta: comparison ? formatComparisonDelta(metric.value, comparison.value) : null };
}
function prefixDelta(label: string, metric: AggregateMetric, comparison?: AggregateMetric): string | null { if (!comparison) return null; const delta = formatComparisonDelta(metric.value, comparison.value); return delta ? `${label} ${delta}` : null; }
function formatMetric(metric: AggregateMetric, distanceUnit: DistanceUnit): string { if (metric.value === null) return "—"; if (metric.unit === "count") return metric.value.toLocaleString(); if (metric.unit === "hours") return `${metric.value.toFixed(1)} h`; return formatDistanceForUnit(metric.value, distanceUnit); }
function buildCompletenessText(type: FlightTypeFilter, metrics: StatsMetricSet, byRole: StatsSlice["byRole"], distanceUnit: DistanceUnit): string { const details: string[] = []; const addIncomplete = (label: string, metric: AggregateMetric) => { if (metric.eligibleCount > 0 && metric.knownCount < metric.eligibleCount) details.push(`${label} ${metric.completenessPct}% complete`); }; if (type !== "commercial") { addIncomplete("Personal hours", byRole.pilot.durationHours); addIncomplete("Hobbs elapsed", byRole.pilot.hobbsHours); } if (type !== "private") addIncomplete("Commercial duration", byRole.passenger.durationHours); addIncomplete("Distance", metrics.distanceMiles); if (metrics.distanceMiles.knownCount > 0) details.push(distanceBasisDisclosure(metrics.distanceMiles, distanceUnit)); return details.join(" · "); }
function distanceBasisDisclosure(metric: AggregateMetric, distanceUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT): string { const basis: string[] = []; if (metric.loggedCount > 0) basis.push(`${metric.loggedCount.toLocaleString()} logged ${metric.loggedCount === 1 ? "value" : "values"} normalized for aggregation`); if (metric.estimatedCount > 0) basis.push(`${metric.estimatedCount.toLocaleString()} great-circle ${metric.estimatedCount === 1 ? "estimate" : "estimates"} from airport coordinates`); const unspecifiedCount = metric.knownCount - metric.loggedCount - metric.estimatedCount; if (unspecifiedCount > 0) basis.push(`${unspecifiedCount.toLocaleString()} ${unspecifiedCount === 1 ? "value has" : "values have"} an unspecified basis`); return `Distance basis: ${basis.join("; ")}. Displayed as ${formatDistanceForUnit(1, distanceUnit).replace(/^1\s*/, "")}.`; }

export { ALL_FLIGHT_FILTERS, MONTH_NAMES, formatCivilDateLabel, formatComparisonBasis, formatPeriodRange, hasActiveFlightFilters };
