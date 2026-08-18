import {
  flightAirportSequence,
  type Flight,
  type MapRoute,
} from "./flight-data";
import type { FlightFilters } from "./flight-filters";
import type {
  CivilDate,
  ComparisonBasis,
  RelativePeriodPreset,
  ResolvedStatsPeriod,
  StatsFact,
  StatsPeriod,
} from "./flight-statistics";

export type RelativePeriodMap = Record<
  RelativePeriodPreset,
  ResolvedStatsPeriod
>;

export type InsightsPeriods = {
  primary: StatsPeriod;
  comparison: StatsPeriod | null;
  comparisonBasis: ComparisonBasis | null;
  comparisonClamped: boolean;
};

export function resolveInsightsPeriods(
  filters: FlightFilters,
  facts: readonly StatsFact[],
  relativePeriods: RelativePeriodMap,
  asOfDate: CivilDate,
): InsightsPeriods {
  if (filters.period !== "any" && filters.period !== "custom") {
    const resolved = relativePeriods[filters.period];
    return {
      primary: resolved.primary,
      comparison: resolved.comparison,
      comparisonBasis: resolved.comparisonBasis,
      comparisonClamped: resolved.comparisonClamped,
    };
  }

  if (filters.period === "custom" && filters.year !== "all") {
    const isYear = filters.month === "all";
    const selectedMonth = filters.month === "all" ? 1 : filters.month;
    const startDate = civilDate(filters.year, selectedMonth, 1);
    const calendarEnd =
      filters.month === "all"
        ? civilDate(filters.year + 1, 1, 1)
        : shiftMonth(startDate, 1);
    const comparisonStart = isYear
      ? civilDate(filters.year - 1, 1, 1)
      : shiftMonth(startDate, -1);
    const isCurrent = startDate <= asOfDate && asOfDate < calendarEnd;

    if (!isCurrent) {
      return {
        primary: statsPeriod("custom", startDate, calendarEnd, false),
        comparison: statsPeriod("custom", comparisonStart, startDate, false),
        comparisonBasis: "calendar-periods",
        comparisonClamped: false,
      };
    }

    const rawElapsedDays = daysBetween(startDate, addDays(asOfDate, 1));
    const comparisonCapacity = daysBetween(comparisonStart, startDate);
    const comparedDays = Math.min(rawElapsedDays, comparisonCapacity);
    const endDateExclusive = addDays(startDate, comparedDays);
    const comparisonEnd = addDays(comparisonStart, comparedDays);
    return {
      primary: statsPeriod(
        "custom",
        startDate,
        endDateExclusive,
        endDateExclusive < calendarEnd,
      ),
      comparison: statsPeriod(
        "custom",
        comparisonStart,
        comparisonEnd,
        comparisonEnd < startDate,
      ),
      comparisonBasis: "equal-elapsed",
      comparisonClamped: comparedDays < rawElapsedDays,
    };
  }

  const dates = facts.map((fact) => fact.date).toSorted();
  const startDate = dates[0] ?? asOfDate;
  const endDateExclusive = addDays(dates.at(-1) ?? asOfDate, 1);
  return {
    primary: {
      preset: filters.period,
      startDate,
      endDateExclusive,
      elapsedDays: daysBetween(startDate, endDateExclusive),
      isPartial: false,
    },
    comparison: null,
    comparisonBasis: null,
    comparisonClamped: false,
  };
}

export function formatComparisonBasis(periods: InsightsPeriods): string {
  if (!periods.comparison || !periods.comparisonBasis) return "";
  if (periods.comparisonBasis === "calendar-periods") {
    return "Complete calendar periods";
  }
  const equalWindow = `Equal ${periods.primary.elapsedDays}-day windows`;
  return periods.comparisonClamped
    ? `${equalWindow}; current range clamped to the shorter prior calendar period`
    : equalWindow;
}

export function formatPeriodRange(period: StatsPeriod): string {
  return `${formatCivilDate(period.startDate)} – ${formatCivilDate(
    addDays(period.endDateExclusive, -1),
  )}`;
}

export function formatCivilDateLabel(value: CivilDate): string {
  return formatCivilDate(value);
}

export function formatComparisonDelta(
  value: number | null,
  baseline: number | null,
): string | null {
  if (value === null || baseline === null) return null;
  if (baseline === 0) return "No prior baseline";
  const percent = Math.round(((value - baseline) / baseline) * 100);
  if (percent === 0) return "No change";
  return `${percent > 0 ? "+" : ""}${percent}%`;
}

export function busiestDirectionalRoute(
  routes: readonly MapRoute[],
): MapRoute | null {
  return (
    routes.toSorted(
      (left, right) =>
        right.flightCount - left.flightCount ||
        left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

export function statsFactsFromFlights(
  flights: readonly Flight[],
): StatsFact[] {
  return flights.map((flight) => {
    const airportCodes = flightAirportSequence(flight).map(({ code }) => code);
    const durationStatus =
      flight.durationHours === undefined
        ? "missing"
        : Number.isFinite(flight.durationHours) && flight.durationHours >= 0
          ? "known"
          : "invalid";
    return {
      id: `map-${flight.id}`,
      date: flight.date.slice(0, 10) as CivilDate,
      kind: flight.kind,
      role: flight.role,
      activity: "flight",
      source: flight.source,
      mapReady: true,
      originCode: flight.origin.code,
      destinationCode: flight.destination.code,
      airportCodes,
      dedupeStatus: "unique",
      ...(durationStatus === "known"
        ? { durationHours: flight.durationHours }
        : {}),
      durationStatus,
      hobbsStatus: "missing",
      distanceMiles: flight.distanceMiles,
      distanceStatus: Number.isFinite(flight.distanceMiles)
        ? "known"
        : "missing",
      distanceBasis: "great-circle",
    };
  });
}

export function addCivilDays(value: CivilDate, days: number): CivilDate {
  return addDays(value, days);
}

function formatCivilDate(value: CivilDate): string {
  const [year, month, day] = value.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function shiftMonth(value: CivilDate, delta: number): CivilDate {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return civilDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function daysBetween(start: CivilDate, end: CivilDate): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86_400_000);
}

function addDays(value: CivilDate, days: number): CivilDate {
  const date = new Date(toUtc(value) + days * 86_400_000);
  return civilDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function toUtc(value: CivilDate): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function civilDate(year: number, month: number, day: number): CivilDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CivilDate;
}

function statsPeriod(
  preset: StatsPeriod["preset"],
  startDate: CivilDate,
  endDateExclusive: CivilDate,
  isPartial: boolean,
): StatsPeriod {
  return {
    preset,
    startDate,
    endDateExclusive,
    elapsedDays: daysBetween(startDate, endDateExclusive),
    isPartial,
  };
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
