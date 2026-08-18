import { describe, expect, it } from "vitest";
import type { FlightFilters } from "./flight-filters";
import {
  busiestDirectionalRoute,
  formatComparisonDelta,
  formatComparisonBasis,
  resolveInsightsPeriods,
  statsFactsFromFlights,
  type RelativePeriodMap,
} from "./flight-insights";
import { airports, sampleFlights, type MapRoute } from "./flight-data";
import {
  resolveStatsPeriod,
  type CivilDate,
} from "./flight-statistics";

const asOfDate = "2026-08-10" as const;
const relativePeriods = Object.fromEntries(
  (["this-year", "last-year", "this-month", "last-month"] as const).map(
    (period) => [
      period,
      resolveStatsPeriod({ period, asOfDate, timeZone: "UTC" }),
    ],
  ),
) as RelativePeriodMap;

describe("persisted flight statistics facts", () => {
  it("treats zero duration as known and absence as missing", () => {
    const facts = statsFactsFromFlights([
      { ...sampleFlights[0], id: "zero", durationHours: 0 },
      { ...sampleFlights[1], id: "missing", durationHours: undefined },
    ]);
    expect(facts[0]).toMatchObject({
      durationHours: 0,
      durationStatus: "known",
    });
    expect(facts[1]).toMatchObject({ durationStatus: "missing" });
    expect(facts[1]).not.toHaveProperty("durationHours");
  });
});

describe("flight insight periods", () => {
  it("uses the server-provided as-of date for equal-elapsed shortcuts", () => {
    const periods = resolveInsightsPeriods(
      filters("this-year"),
      [],
      relativePeriods,
      asOfDate,
    );

    expect(periods.primary).toMatchObject({
      startDate: "2026-01-01",
      endDateExclusive: "2026-08-11",
      elapsedDays: 222,
      isPartial: true,
    });
    expect(periods.comparison?.elapsedDays).toBe(222);
  });

  it("compares a completed custom month to the complete preceding month", () => {
    const periods = resolveInsightsPeriods(
      {
        ...filters("custom"),
        year: 2025,
        month: 2,
      },
      [],
      relativePeriods,
      asOfDate,
    );

    expect(periods.primary).toMatchObject({
      preset: "custom",
      startDate: "2025-02-01",
      endDateExclusive: "2025-03-01",
      elapsedDays: 28,
    });
    expect(periods.comparison).toMatchObject({
      startDate: "2025-01-01",
      endDateExclusive: "2025-02-01",
      elapsedDays: 31,
    });
    expect(periods.comparisonBasis).toBe("calendar-periods");
    expect(formatComparisonBasis(periods)).toBe("Complete calendar periods");
  });

  it("uses equal elapsed days for a current partial custom month", () => {
    const currentAsOf = "2025-03-30" as const;
    const periods = resolveInsightsPeriods(
      {
        ...filters("custom"),
        year: 2025,
        month: 3,
      },
      [],
      relativePeriodMap(currentAsOf),
      currentAsOf,
    );

    expect(periods.primary).toMatchObject({
      startDate: "2025-03-01",
      endDateExclusive: "2025-03-29",
      elapsedDays: 28,
    });
    expect(periods.comparison).toMatchObject({
      startDate: "2025-02-01",
      endDateExclusive: "2025-03-01",
      elapsedDays: 28,
    });
    expect(periods.comparisonClamped).toBe(true);
    expect(formatComparisonBasis(periods)).toMatch(
      /Equal 28-day windows; current range clamped/,
    );
  });

  it("uses equal elapsed days for the current custom year", () => {
    const currentAsOf = "2024-12-31" as const;
    const periods = resolveInsightsPeriods(
      {
        ...filters("custom"),
        year: 2024,
      },
      [],
      relativePeriodMap(currentAsOf),
      currentAsOf,
    );

    expect(periods.primary.elapsedDays).toBe(365);
    expect(periods.comparison?.elapsedDays).toBe(365);
    expect(periods.primary.endDateExclusive).toBe("2024-12-31");
    expect(periods.comparisonClamped).toBe(true);
  });

  it("compares completed custom years as complete civil years", () => {
    const periods = resolveInsightsPeriods(
      {
        ...filters("custom"),
        year: 2024,
      },
      [],
      relativePeriods,
      asOfDate,
    );

    expect(periods.primary).toMatchObject({
      startDate: "2024-01-01",
      endDateExclusive: "2025-01-01",
      elapsedDays: 366,
    });
    expect(periods.comparison).toMatchObject({
      startDate: "2023-01-01",
      endDateExclusive: "2024-01-01",
      elapsedDays: 365,
    });
    expect(periods.comparisonBasis).toBe("calendar-periods");
  });

  it("resolves custom December and its comparison across civil-year boundaries", () => {
    const periods = resolveInsightsPeriods(
      {
        ...filters("custom"),
        year: 2024,
        month: 12,
      },
      [],
      relativePeriods,
      asOfDate,
    );

    expect(periods.primary.startDate).toBe("2024-12-01");
    expect(periods.primary.endDateExclusive).toBe("2025-01-01");
    expect(periods.comparison?.startDate).toBe("2024-11-01");
    expect(periods.comparison?.endDateExclusive).toBe("2024-12-01");
  });
});

describe("flight insight presentation helpers", () => {
  it("does not manufacture a +100% delta when the baseline is zero", () => {
    expect(formatComparisonDelta(4, 0)).toBe("No prior baseline");
    expect(formatComparisonDelta(0, 0)).toBe("No prior baseline");
    expect(formatComparisonDelta(null, 2)).toBeNull();
  });

  it("returns one deterministic busiest directional route", () => {
    const routes: MapRoute[] = [
      route("reverse", "SEA", "PAE", 2),
      route("forward", "PAE", "SEA", 3),
      route("other", "SEA", "JFK", 3),
    ];

    expect(busiestDirectionalRoute(routes)?.id).toBe("forward");
  });
});

function filters(period: FlightFilters["period"]): FlightFilters {
  return {
    type: "all",
    period,
    year: "all",
    month: "all",
    aircraft: "all",
    registration: "all",
  };
}

function relativePeriodMap(date: CivilDate): RelativePeriodMap {
  return Object.fromEntries(
    (["this-year", "last-year", "this-month", "last-month"] as const).map(
      (period) => [
        period,
        resolveStatsPeriod({ period, asOfDate: date, timeZone: "UTC" }),
      ],
    ),
  ) as RelativePeriodMap;
}

function route(
  id: string,
  origin: keyof typeof airports,
  destination: keyof typeof airports,
  flightCount: number,
): MapRoute {
  return {
    id,
    origin: airports[origin],
    destination: airports[destination],
    kind: "private",
    flightCount,
  };
}
