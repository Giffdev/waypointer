import { describe, expect, it } from "vitest";
import {
  aggregateFlightStatistics,
  civilDateInTimeZone,
  resolveStatsPeriod,
  type StatsFact,
} from "./flight-statistics";

describe("relative statistics periods", () => {
  it("uses equal elapsed days across a leap-year boundary", () => {
    const resolved = resolveStatsPeriod({
      period: "this-year",
      asOfDate: "2024-03-01",
      timeZone: "America/Los_Angeles",
    });

    expect(resolved.primary).toMatchObject({
      startDate: "2024-01-01",
      endDateExclusive: "2024-03-02",
      elapsedDays: 61,
      isPartial: true,
    });
    expect(resolved.comparison).toMatchObject({
      startDate: "2023-01-01",
      endDateExclusive: "2023-03-03",
      elapsedDays: 61,
      isPartial: true,
    });
  });

  it("clamps both partial month windows to shorter February", () => {
    const resolved = resolveStatsPeriod({
      period: "this-month",
      asOfDate: "2025-03-30",
      timeZone: "UTC",
    });

    expect(resolved.primary).toMatchObject({
      startDate: "2025-03-01",
      endDateExclusive: "2025-03-29",
      elapsedDays: 28,
      isPartial: true,
    });
    expect(resolved.comparison).toMatchObject({
      startDate: "2025-02-01",
      endDateExclusive: "2025-03-01",
      elapsedDays: 28,
      isPartial: false,
    });
    expect(resolved.comparisonClamped).toBe(true);
    expect(resolved.comparisonBasis).toBe("equal-elapsed");
  });

  it("clamps a 31-day partial month to a 30-day preceding month", () => {
    const resolved = resolveStatsPeriod({
      period: "this-month",
      asOfDate: "2025-05-31",
      timeZone: "UTC",
    });

    expect(resolved.primary).toMatchObject({
      startDate: "2025-05-01",
      endDateExclusive: "2025-05-31",
      elapsedDays: 30,
    });
    expect(resolved.comparison).toMatchObject({
      startDate: "2025-04-01",
      endDateExclusive: "2025-05-01",
      elapsedDays: 30,
    });
    expect(resolved.comparisonClamped).toBe(true);
  });

  it("uses leap February's 29 days as the deterministic month clamp", () => {
    const resolved = resolveStatsPeriod({
      period: "this-month",
      asOfDate: "2024-03-30",
      timeZone: "UTC",
    });

    expect(resolved.primary.elapsedDays).toBe(29);
    expect(resolved.primary.endDateExclusive).toBe("2024-03-30");
    expect(resolved.comparison).toMatchObject({
      startDate: "2024-02-01",
      endDateExclusive: "2024-03-01",
      elapsedDays: 29,
    });
  });

  it("clamps leap-year day 366 when the prior year has 365 days", () => {
    const resolved = resolveStatsPeriod({
      period: "this-year",
      asOfDate: "2024-12-31",
      timeZone: "UTC",
    });

    expect(resolved.primary).toMatchObject({
      startDate: "2024-01-01",
      endDateExclusive: "2024-12-31",
      elapsedDays: 365,
    });
    expect(resolved.comparison).toMatchObject({
      startDate: "2023-01-01",
      endDateExclusive: "2024-01-01",
      elapsedDays: 365,
    });
    expect(resolved.comparisonClamped).toBe(true);
  });

  it("resolves complete last-month periods across year boundaries", () => {
    const resolved = resolveStatsPeriod({
      period: "last-month",
      asOfDate: "2026-01-15",
      timeZone: "UTC",
    });

    expect(resolved.primary).toMatchObject({
      startDate: "2025-12-01",
      endDateExclusive: "2026-01-01",
      isPartial: false,
    });
    expect(resolved.comparison).toMatchObject({
      startDate: "2025-11-01",
      endDateExclusive: "2025-12-01",
      isPartial: false,
    });
  });

  it("derives the civil date in the requested timezone", () => {
    expect(
      civilDateInTimeZone(
        new Date("2026-08-11T01:00:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-08-10");
  });
});

describe("flight statistics aggregation", () => {
  const facts: StatsFact[] = [
    fact("pilot-known", {
      role: "pilot",
      kind: "private",
      durationHours: 1.2,
      durationStatus: "known",
      hobbsElapsedHours: 1.1,
      hobbsStatus: "known",
      distanceMiles: 115.077945,
      distanceStatus: "known",
      distanceBasis: "logged-nautical-converted",
      originCode: "AAA",
      destinationCode: "BBB",
      mapReady: true,
    }),
    fact("pilot-invalid", {
      role: "pilot",
      kind: "private",
      durationStatus: "missing",
      hobbsStatus: "invalid",
      distanceMiles: 80,
      distanceStatus: "missing",
      distanceBasis: "great-circle",
      originCode: "AAA",
      destinationCode: "BBB",
      mapReady: true,
      dedupeStatus: "ambiguous",
    }),
    fact("pilot-exact", {
      role: "pilot",
      kind: "private",
      durationHours: 99,
      durationStatus: "known",
      hobbsElapsedHours: 99,
      hobbsStatus: "known",
      distanceMiles: 99,
      distanceStatus: "known",
      distanceBasis: "logged-nautical-converted",
      originCode: "AAA",
      destinationCode: "BBB",
      mapReady: true,
      dedupeStatus: "exact-duplicate",
    }),
    fact("passenger-same-route", {
      role: "passenger",
      kind: "commercial",
      durationHours: 2.5,
      durationStatus: "known",
      hobbsStatus: "missing",
      distanceMiles: 200,
      distanceStatus: "missing",
      distanceBasis: "great-circle",
      originCode: "AAA",
      destinationCode: "BBB",
      mapReady: true,
    }),
    fact("simulator", {
      role: "pilot",
      kind: "private",
      activity: "simulator",
      mapReady: false,
      durationHours: 0.8,
      durationStatus: "known",
      hobbsStatus: "missing",
      distanceStatus: "missing",
    }),
  ];

  it("retains unknowns, invalids, estimates, ambiguous candidates, and roles", () => {
    const result = aggregateFlightStatistics(facts, {
      period: "this-year",
      asOfDate: "2026-08-10",
      timeZone: "UTC",
    });

    expect(result.primary.metrics.records.value).toBe(4);
    expect(result.primary.metrics.flights.value).toBe(3);
    expect(result.primary.metrics.simulatorSessions.value).toBe(1);
    expect(result.primary.metrics.durationHours).toMatchObject({
      value: 4.5,
      eligibleCount: 4,
      knownCount: 3,
      invalidCount: 0,
      estimatedCount: 0,
      loggedCount: 0,
      completenessPct: 75,
    });
    expect(result.primary.metrics.hobbsHours).toMatchObject({
      value: 1.1,
      eligibleCount: 2,
      knownCount: 1,
      invalidCount: 1,
      completenessPct: 50,
    });
    expect(result.primary.metrics.distanceMiles).toMatchObject({
      value: 395.077945,
      eligibleCount: 3,
      knownCount: 3,
      estimatedCount: 2,
      loggedCount: 1,
      completenessPct: 100,
    });
    expect(result.primary.metrics.uniqueRoutes.value).toBe(2);
    expect(result.primary.metrics.repeatedRoutes.value).toBe(1);
    expect(result.primary.metrics.repeatFlights.value).toBe(1);
    expect(result.primary.quality).toEqual({
      exactDuplicatesExcluded: 1,
      ambiguousCandidatesIncluded: 1,
    });
    expect(result.primary.byRole.pilot.records.value).toBe(3);
    expect(result.primary.byRole.passenger.records.value).toBe(1);
  });

  it("applies active filters without merging pilot and passenger facts", () => {
    const result = aggregateFlightStatistics(facts, {
      period: "this-year",
      asOfDate: "2026-08-10",
      timeZone: "UTC",
      filters: {
        kind: "private",
        activities: ["flight"],
        airportCodes: ["AAA"],
      },
    });

    expect(result.primary.metrics.records.value).toBe(2);
    expect(result.primary.byRole.pilot.flights.value).toBe(2);
    expect(result.primary.byRole.passenger.flights.value).toBe(0);
    expect(result.primary.quality.ambiguousCandidatesIncluded).toBe(1);
  });

  it("is deterministic regardless of fact input order", () => {
    const query = {
      period: "this-year" as const,
      asOfDate: "2026-08-10" as const,
      timeZone: "UTC",
    };

    expect(aggregateFlightStatistics(facts, query)).toEqual(
      aggregateFlightStatistics([...facts].reverse(), query),
    );
  });
});

function fact(id: string, overrides: Partial<StatsFact>): StatsFact {
  return {
    id,
    date: "2026-04-05",
    kind: "private",
    role: "pilot",
    activity: "flight",
    source: "ForeFlight",
    mapReady: false,
    dedupeStatus: "unique",
    durationStatus: "missing",
    hobbsStatus: "missing",
    distanceStatus: "missing",
    ...overrides,
  };
}
