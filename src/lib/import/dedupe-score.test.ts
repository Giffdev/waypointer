import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { applyDuplicateCandidates, DUPLICATE_RULE_VERSION } from "./dedupe";
import { createRowFingerprint } from "./fingerprint";
import type { ProposedImportFlight, StoredImportRow } from "./types";

const airport = (code: string): Airport => ({
  code,
  name: code,
  city: code,
  country: "US",
  lat: 0,
  lon: 0,
  facility: "commercial",
});

function proposal(overrides: Partial<ProposedImportFlight> = {}): ProposedImportFlight {
  return {
    date: "2026-08-01",
    departureTime: "09:00",
    origin: {
      status: "resolved",
      identifier: "KSEA",
      airportId: "airport-sea",
      airport: airport("SEA"),
    },
    destination: {
      status: "resolved",
      identifier: "KJFK",
      airportId: "airport-jfk",
      airport: airport("JFK"),
    },
    kind: "commercial",
    role: "passenger",
    flightNumber: "AS100",
    aircraft: "Boeing 737",
    source: "FlightRadar24",
    ...overrides,
  };
}

function row(id: string, flight = proposal()): StoredImportRow {
  return {
    id,
    batchId: "batch",
    rowNumber: 2,
    rawSnapshot: ["source truth"],
    proposedFlight: flight,
    issues: [],
    validationState: "ready",
    commitReady: true,
    decision: "pending",
    rowFingerprint: createRowFingerprint("user-a", flight),
    provenance: {
      adapterId: "test",
      adapterLabel: "Test",
      adapterVersion: 1,
      source: "FlightRadar24",
      sourceRowNumber: 2,
    },
  };
}

describe("weighted duplicate scoring", () => {
  it("produces versioned explanations without resolving automatically", () => {
    const flight = proposal({ departureTime: "10:00", flightNumber: undefined });
    const [staged] = applyDuplicateCandidates([row("row-a", flight)], [
      {
        flightId: "flight-a",
        fingerprint: {
          algorithm: "sha256",
          version: 1,
          value: "different",
        },
        flight: proposal({ departureTime: "09:30", flightNumber: undefined }),
      },
    ]);
    expect(staged.duplicateCandidate).toMatchObject({
      candidateId: "flight-a",
      scope: "existing-flight",
      ruleVersion: DUPLICATE_RULE_VERSION,
      resolution: "pending",
    });
    expect(staged.duplicateCandidate?.score).toBeGreaterThanOrEqual(0.7);
    expect(staged.duplicateCandidate?.signals.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["same-date", "same-route", "near-time"]),
    );
  });

  it("does not flag same-day route records with materially different identity", () => {
    const [staged] = applyDuplicateCandidates([row("row-a")], [
      {
        flightId: "flight-a",
        fingerprint: {
          algorithm: "sha256",
          version: 1,
          value: "different",
        },
        flight: proposal({
          departureTime: "18:00",
          flightNumber: "AS999",
          aircraft: "Airbus A320",
          role: "pilot",
          kind: "private",
        }),
      },
    ]);
    expect(staged.duplicateCandidate).toBeUndefined();
  });

  it("retains an explicit resolution only while the candidate remains stable", () => {
    const first = applyDuplicateCandidates([row("row-a"), row("row-b")], []);
    first[1].duplicateCandidate!.resolution = "accept_new";
    const rescored = applyDuplicateCandidates(first, []);
    expect(rescored[1].duplicateCandidate?.resolution).toBe("accept_new");
  });
});
