import { describe, expect, it } from "vitest";
import {
  assessDuplicateCandidates,
  findRoleDistinctOverlaps,
  findDuplicateIndexes,
  flightFingerprint,
  type NormalizedFlight,
} from "./reconciliation";

const baseFlight: NormalizedFlight = {
  userId: "user-1",
  departureDate: "2026-08-01T14:00:00Z",
  originCode: "sea",
  destinationCode: "JFK",
  kind: "commercial",
  role: "passenger",
  flightNumber: " AS 26 ",
};

describe("flight reconciliation", () => {
  it("normalizes airport and flight identifiers for stable matching", () => {
    expect(flightFingerprint(baseFlight)).toBe(
      "user-1|2026-08-01|SEA|JFK|commercial|passenger|AS 26|",
    );
  });

  it("only marks later identical rows as duplicates", () => {
    expect(
      findDuplicateIndexes([
        baseFlight,
        { ...baseFlight, originCode: " SEA ", flightNumber: "as 26" },
        { ...baseFlight, destinationCode: "BOS" },
      ]),
    ).toEqual([1]);
  });

  it("never deduplicates records across users", () => {
    expect(findDuplicateIndexes([baseFlight, { ...baseFlight, userId: "user-2" }])).toEqual([]);
  });

  it("keeps passenger and pilot records distinct even on the same date and route", () => {
    expect(
      assessDuplicateCandidates([
        baseFlight,
        { ...baseFlight, kind: "private", role: "pilot" },
      ]),
    ).toEqual([]);
    expect(
      findRoleDistinctOverlaps([
        baseFlight,
        { ...baseFlight, kind: "private", role: "pilot" },
      ]),
    ).toEqual([
      {
        index: 1,
        candidateOfIndex: 0,
        rule: "same-day-route-role-distinct",
      },
    ]);
  });

  it("separates exact signals from same-day ambiguous candidates", () => {
    expect(
      assessDuplicateCandidates([
        { ...baseFlight, departureTime: "08:15", sourceRecordId: "row-1" },
        { ...baseFlight, departureTime: "08:15", sourceRecordId: "row-2" },
        { ...baseFlight, departureTime: "09:30", sourceRecordId: "row-3" },
        { ...baseFlight, departureTime: "10:00", sourceRecordId: "row-1" },
      ]),
    ).toEqual([
      { index: 1, candidateOfIndex: 0, confidence: "exact", rule: "same-departure-time" },
      { index: 2, candidateOfIndex: 0, confidence: "ambiguous", rule: "same-day-route" },
      { index: 3, candidateOfIndex: 0, confidence: "exact", rule: "same-source-record" },
    ]);
  });
});
