import type { FlightKind, FlightRole, FlightSource } from "./flight-data";

export const STATS_FACT_SCHEMA_VERSION = 1 as const;

export type CivilDate = `${number}-${number}-${number}`;
export type StatsActivity = "flight" | "simulator" | "ground" | "unknown";
export type StatsSource = FlightSource;
export type StatsValueStatus = "known" | "missing" | "invalid";
export type StatsDedupeStatus = "unique" | "exact-duplicate" | "ambiguous";
export type DistanceBasis = "logged-nautical-converted" | "great-circle";

export type StatsFact = {
  id: string;
  date: CivilDate;
  kind: FlightKind;
  role: FlightRole;
  activity: StatsActivity;
  source: StatsSource;
  mapReady: boolean;
  originCode?: string;
  destinationCode?: string;
  airportCodes?: string[];
  dedupeStatus: StatsDedupeStatus;
  durationHours?: number;
  durationStatus: StatsValueStatus;
  hobbsElapsedHours?: number;
  hobbsStatus: StatsValueStatus;
  distanceMiles?: number;
  distanceStatus: StatsValueStatus;
  distanceBasis?: DistanceBasis;
};

export type RelativePeriodPreset =
  | "this-year"
  | "last-year"
  | "this-month"
  | "last-month";
export type StatsPeriodPreset = RelativePeriodPreset | "any" | "custom";
export type ComparisonBasis = "equal-elapsed" | "calendar-periods";

export type StatsPeriod = {
  preset: StatsPeriodPreset;
  startDate: CivilDate;
  endDateExclusive: CivilDate;
  isPartial: boolean;
  elapsedDays: number;
};

export type ResolvedStatsPeriod = {
  primary: StatsPeriod;
  comparison: StatsPeriod;
  comparisonBasis: ComparisonBasis;
  comparisonClamped: boolean;
  asOfDate: CivilDate;
  timeZone: string;
};

export type StatsFilters = {
  kind?: "all" | FlightKind;
  role?: "all" | FlightRole;
  activities?: StatsActivity[];
  mapReady?: "all" | boolean;
  sources?: StatsSource[];
  airportCodes?: string[];
};

export type StatsQuery = {
  period: RelativePeriodPreset;
  filters?: StatsFilters;
  asOfDate?: CivilDate;
  timeZone?: string;
  now?: Date;
};

export type AggregateMetric = {
  value: number | null;
  unit: "count" | "hours" | "miles";
  eligibleCount: number;
  knownCount: number;
  invalidCount: number;
  estimatedCount: number;
  loggedCount: number;
  completenessPct: number;
};

export type StatsMetricSet = {
  records: AggregateMetric;
  flights: AggregateMetric;
  simulatorSessions: AggregateMetric;
  groundSessions: AggregateMetric;
  mappedFlights: AggregateMetric;
  durationHours: AggregateMetric;
  hobbsHours: AggregateMetric;
  distanceMiles: AggregateMetric;
  uniqueAirports: AggregateMetric;
  uniqueRoutes: AggregateMetric;
  repeatedRoutes: AggregateMetric;
  repeatFlights: AggregateMetric;
};

export type StatsSlice = {
  metrics: StatsMetricSet;
  byRole: Record<FlightRole, StatsMetricSet>;
  quality: {
    exactDuplicatesExcluded: number;
    ambiguousCandidatesIncluded: number;
  };
};

export type FlightStatisticsResult = {
  contractVersion: typeof STATS_FACT_SCHEMA_VERSION;
  period: ResolvedStatsPeriod;
  primary: StatsSlice;
  comparison: StatsSlice;
};

const STATUTE_MILES_PER_NAUTICAL_MILE = 1.150779448;

export function nauticalMilesToStatuteMiles(nauticalMiles: number): number {
  return round(nauticalMiles * STATUTE_MILES_PER_NAUTICAL_MILE, 6);
}

export function greatCircleStatuteMiles(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(destination.lat - origin.lat);
  const longitudeDelta = radians(destination.lon - origin.lon);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(origin.lat)) *
      Math.cos(radians(destination.lat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return round(
    3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))),
    6,
  );
}

export function civilDateInTimeZone(
  now: Date,
  timeZone: string,
): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}` as CivilDate;
}

export function resolveStatsPeriod(query: StatsQuery): ResolvedStatsPeriod {
  const timeZone =
    query.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const asOfDate =
    query.asOfDate ?? civilDateInTimeZone(query.now ?? new Date(), timeZone);
  assertCivilDate(asOfDate);
  const asOf = parseCivilDate(asOfDate);

  if (query.period === "this-year") {
    const primaryStart = civilDate(asOf.year, 1, 1);
    const calendarPrimaryEnd = civilDate(asOf.year + 1, 1, 1);
    const rawPrimaryEnd = addDays(asOfDate, 1);
    const rawElapsedDays = daysBetween(primaryStart, rawPrimaryEnd);
    const comparisonStart = civilDate(asOf.year - 1, 1, 1);
    const comparedDays = Math.min(rawElapsedDays, daysInYear(asOf.year - 1));
    const primaryEnd = addDays(primaryStart, comparedDays);
    const comparisonEnd = addDays(comparisonStart, comparedDays);
    return {
      asOfDate,
      timeZone,
      comparisonBasis: "equal-elapsed",
      comparisonClamped: comparedDays < rawElapsedDays,
      primary: period(
        query.period,
        primaryStart,
        primaryEnd,
        primaryEnd < calendarPrimaryEnd,
      ),
      comparison: period(
        query.period,
        comparisonStart,
        comparisonEnd,
        comparisonEnd < civilDate(asOf.year, 1, 1),
      ),
    };
  }

  if (query.period === "this-month") {
    const primaryStart = civilDate(asOf.year, asOf.month, 1);
    const currentMonthEnd = shiftMonth(asOf.year, asOf.month, 1);
    const calendarPrimaryEnd = civilDate(
      currentMonthEnd.year,
      currentMonthEnd.month,
      1,
    );
    const rawPrimaryEnd = addDays(asOfDate, 1);
    const rawElapsedDays = daysBetween(primaryStart, rawPrimaryEnd);
    const previousMonth = shiftMonth(asOf.year, asOf.month, -1);
    const comparisonStart = civilDate(previousMonth.year, previousMonth.month, 1);
    const comparisonCalendarEnd = primaryStart;
    const comparedDays = Math.min(
      rawElapsedDays,
      daysInMonth(previousMonth.year, previousMonth.month),
    );
    const primaryEnd = addDays(primaryStart, comparedDays);
    const comparisonEnd = addDays(comparisonStart, comparedDays);
    return {
      asOfDate,
      timeZone,
      comparisonBasis: "equal-elapsed",
      comparisonClamped: comparedDays < rawElapsedDays,
      primary: period(
        query.period,
        primaryStart,
        primaryEnd,
        primaryEnd < calendarPrimaryEnd,
      ),
      comparison: period(
        query.period,
        comparisonStart,
        comparisonEnd,
        comparisonEnd < comparisonCalendarEnd,
      ),
    };
  }

  if (query.period === "last-year") {
    const primaryStart = civilDate(asOf.year - 1, 1, 1);
    const primaryEnd = civilDate(asOf.year, 1, 1);
    const comparisonStart = civilDate(asOf.year - 2, 1, 1);
    return {
      asOfDate,
      timeZone,
      comparisonBasis: "calendar-periods",
      comparisonClamped: false,
      primary: period(query.period, primaryStart, primaryEnd, false),
      comparison: period(
        query.period,
        comparisonStart,
        primaryStart,
        false,
      ),
    };
  }

  const previousMonth = shiftMonth(asOf.year, asOf.month, -1);
  const comparisonMonth = shiftMonth(asOf.year, asOf.month, -2);
  const primaryStart = civilDate(previousMonth.year, previousMonth.month, 1);
  const primaryEnd = civilDate(asOf.year, asOf.month, 1);
  const comparisonStart = civilDate(
    comparisonMonth.year,
    comparisonMonth.month,
    1,
  );
  return {
    asOfDate,
    timeZone,
    comparisonBasis: "calendar-periods",
    comparisonClamped: false,
    primary: period(query.period, primaryStart, primaryEnd, false),
    comparison: period(
      query.period,
      comparisonStart,
      primaryStart,
      false,
    ),
  };
}

export function aggregateFlightStatistics(
  facts: readonly StatsFact[],
  query: StatsQuery,
): FlightStatisticsResult {
  const resolved = resolveStatsPeriod(query);
  return {
    contractVersion: STATS_FACT_SCHEMA_VERSION,
    period: resolved,
    primary: aggregatePeriod(facts, resolved.primary, query.filters),
    comparison: aggregatePeriod(
      facts,
      resolved.comparison,
      query.filters,
    ),
  };
}

export function aggregateStatsSlice(
  facts: readonly StatsFact[],
  statsPeriod: StatsPeriod,
  filters?: StatsFilters,
): StatsSlice {
  return aggregatePeriod(facts, statsPeriod, filters);
}

function aggregatePeriod(
  facts: readonly StatsFact[],
  statsPeriod: StatsPeriod,
  filters: StatsFilters | undefined,
): StatsSlice {
  const matching = facts
    .filter(
      (fact) =>
        fact.date >= statsPeriod.startDate &&
        fact.date < statsPeriod.endDateExclusive &&
        matchesFilters(fact, filters),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const exactDuplicatesExcluded = matching.filter(
    (fact) => fact.dedupeStatus === "exact-duplicate",
  ).length;
  const canonical = matching.filter(
    (fact) => fact.dedupeStatus !== "exact-duplicate",
  );

  return {
    metrics: aggregateMetricSet(canonical),
    byRole: {
      pilot: aggregateMetricSet(
        canonical.filter((fact) => fact.role === "pilot"),
      ),
      passenger: aggregateMetricSet(
        canonical.filter((fact) => fact.role === "passenger"),
      ),
    },
    quality: {
      exactDuplicatesExcluded,
      ambiguousCandidatesIncluded: canonical.filter(
        (fact) => fact.dedupeStatus === "ambiguous",
      ).length,
    },
  };
}

function aggregateMetricSet(facts: readonly StatsFact[]): StatsMetricSet {
  const flights = facts.filter((fact) => fact.activity === "flight");
  const simulator = facts.filter((fact) => fact.activity === "simulator");
  const ground = facts.filter((fact) => fact.activity === "ground");
  const mappedFlights = flights.filter((fact) => fact.mapReady);
  const hobbsEligible = flights.filter((fact) => fact.role === "pilot");
  const routeEligible = flights.filter(
    (
      fact,
    ): fact is StatsFact & {
      originCode: string;
      destinationCode: string;
    } => Boolean(fact.mapReady && fact.originCode && fact.destinationCode),
  );
  const airports = new Set(
    routeEligible.flatMap((fact) =>
      fact.airportCodes && fact.airportCodes.length >= 2
        ? fact.airportCodes
        : [fact.originCode, fact.destinationCode],
    ),
  );
  const routeCounts = new Map<string, number>();
  for (const fact of routeEligible) {
    const sequence =
      fact.airportCodes && fact.airportCodes.length >= 2
        ? fact.airportCodes
        : [fact.originCode, fact.destinationCode];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const key = [
        fact.kind,
        fact.role,
        sequence[index],
        sequence[index + 1],
      ].join("|");
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
    }
  }
  const repeatedRoutes = [...routeCounts.values()].filter(
    (count) => count > 1,
  );

  return {
    records: countMetric(facts.length, facts.length),
    flights: countMetric(flights.length, flights.length),
    simulatorSessions: countMetric(simulator.length, simulator.length),
    groundSessions: countMetric(ground.length, ground.length),
    mappedFlights: countMetric(mappedFlights.length, flights.length),
    durationHours: measureMetric(
      facts,
      (fact) => fact.durationHours,
      (fact) => fact.durationStatus,
      () => false,
      () => false,
      "hours",
    ),
    hobbsHours: measureMetric(
      hobbsEligible,
      (fact) => fact.hobbsElapsedHours,
      (fact) => fact.hobbsStatus,
      () => false,
      () => false,
      "hours",
    ),
    distanceMiles: measureMetric(
      flights,
      (fact) => fact.distanceMiles,
      (fact) => fact.distanceStatus,
      (fact) => fact.distanceBasis === "great-circle",
      (fact) => fact.distanceBasis === "logged-nautical-converted",
      "miles",
    ),
    uniqueAirports: countMetric(airports.size, routeEligible.length),
    uniqueRoutes: countMetric(routeCounts.size, routeEligible.length),
    repeatedRoutes: countMetric(
      repeatedRoutes.length,
      routeEligible.length,
    ),
    repeatFlights: countMetric(
      repeatedRoutes.reduce((total, count) => total + count - 1, 0),
      routeEligible.length,
    ),
  };
}

function measureMetric(
  facts: readonly StatsFact[],
  value: (fact: StatsFact) => number | undefined,
  status: (fact: StatsFact) => StatsValueStatus,
  estimated: (fact: StatsFact) => boolean,
  logged: (fact: StatsFact) => boolean,
  unit: "hours" | "miles",
): AggregateMetric {
  const known = facts.filter((fact) => Number.isFinite(value(fact)));
  return {
    value:
      known.length === 0
        ? null
        : round(
            known.reduce((total, fact) => total + (value(fact) ?? 0), 0),
            6,
          ),
    unit,
    eligibleCount: facts.length,
    knownCount: known.length,
    invalidCount: facts.filter((fact) => status(fact) === "invalid").length,
    estimatedCount: known.filter(estimated).length,
    loggedCount: known.filter(logged).length,
    completenessPct: percentage(known.length, facts.length),
  };
}

function countMetric(value: number, eligibleCount: number): AggregateMetric {
  return {
    value,
    unit: "count",
    eligibleCount,
    knownCount: eligibleCount,
    invalidCount: 0,
    estimatedCount: 0,
    loggedCount: 0,
    completenessPct: eligibleCount === 0 ? 0 : 100,
  };
}

function matchesFilters(
  fact: StatsFact,
  filters: StatsFilters | undefined,
): boolean {
  if (!filters) return true;
  if (filters.kind && filters.kind !== "all" && fact.kind !== filters.kind) {
    return false;
  }
  if (filters.role && filters.role !== "all" && fact.role !== filters.role) {
    return false;
  }
  if (filters.activities?.length && !filters.activities.includes(fact.activity)) {
    return false;
  }
  if (
    filters.mapReady !== undefined &&
    filters.mapReady !== "all" &&
    fact.mapReady !== filters.mapReady
  ) {
    return false;
  }
  if (filters.sources?.length && !filters.sources.includes(fact.source)) {
    return false;
  }
  if (filters.airportCodes?.length) {
    const airportCodes = new Set(
      filters.airportCodes.map((code) => code.trim().toUpperCase()),
    );
    if (
      !(fact.airportCodes ?? [
        fact.originCode ?? "",
        fact.destinationCode ?? "",
      ]).some((code) => airportCodes.has(code))
    ) {
      return false;
    }
  }
  return true;
}

function period(
  preset: StatsPeriodPreset,
  startDate: CivilDate,
  endDateExclusive: CivilDate,
  isPartial: boolean,
): StatsPeriod {
  return {
    preset,
    startDate,
    endDateExclusive,
    isPartial,
    elapsedDays: daysBetween(startDate, endDateExclusive),
  };
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + month - 1 + delta;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function daysInYear(year: number): number {
  return daysBetween(civilDate(year, 1, 1), civilDate(year + 1, 1, 1));
}

function daysBetween(start: CivilDate, end: CivilDate): number {
  return Math.round(
    (toUtcMilliseconds(end) - toUtcMilliseconds(start)) / 86_400_000,
  );
}

function addDays(value: CivilDate, days: number): CivilDate {
  const date = new Date(toUtcMilliseconds(value) + days * 86_400_000);
  return civilDate(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function parseCivilDate(value: CivilDate): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function assertCivilDate(value: string): asserts value is CivilDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid civil date: ${value}`);
  }
  const parsed = parseCivilDate(value as CivilDate);
  if (
    civilDate(parsed.year, parsed.month, parsed.day) !== value ||
    parsed.month < 1 ||
    parsed.month > 12 ||
    parsed.day < 1 ||
    parsed.day > daysInMonth(parsed.year, parsed.month)
  ) {
    throw new Error(`Invalid civil date: ${value}`);
  }
}

function toUtcMilliseconds(value: CivilDate): number {
  const { year, month, day } = parseCivilDate(value);
  return Date.UTC(year, month - 1, day);
}

function civilDate(year: number, month: number, day: number): CivilDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CivilDate;
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100, 1);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
