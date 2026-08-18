import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { applyProposalCorrection, validateProposalPatch } from "./corrections";
import type { StoredImportRow } from "./types";

const airport: Airport = {
  code: "SEA",
  name: "Seattle-Tacoma International",
  city: "Seattle",
  country: "US",
  lat: 47,
  lon: -122,
  facility: "commercial",
};

function unresolvedRow(): StoredImportRow {
  return {
    id: "row-a",
    batchId: "batch-a",
    rowNumber: 2,
    rawSnapshot: ["KXXX", "KJFK", "private source note"],
    proposedFlight: {
      date: "2026-08-01",
      originIdentifier: "KXXX",
      origin: { status: "not-found", identifier: "KXXX" },
      destinationIdentifier: "KJFK",
      destination: { status: "not-found", identifier: "KJFK" },
      kind: "commercial",
      role: "passenger",
      source: "FlightRadar24",
    },
    issues: [
      {
        code: "invalid-airport-identifier",
        field: "From",
        message: "Unknown origin",
        severity: "error",
      },
    ],
    validationState: "unresolved",
    commitReady: false,
    decision: "pending",
    provenance: {
      adapterId: "test",
      adapterLabel: "Test",
      adapterVersion: 1,
      source: "FlightRadar24",
      sourceRowNumber: 2,
    },
  };
}

describe("staged corrections", () => {
  it("preserves raw source truth while auditing canonical airport selection", () => {
    const source = unresolvedRow();
    const corrected = applyProposalCorrection(
      source,
      {
        origin: {
          status: "resolved",
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    expect(corrected.rawSnapshot).toEqual(source.rawSnapshot);
    expect(corrected.proposedFlight.origin).toMatchObject({
      status: "resolved",
      airportId: "airport-sea",
    });
    expect(corrected.issues).toEqual([]);
    expect(corrected.corrections).toHaveLength(1);
    expect(corrected.corrections?.[0]).toMatchObject({
      field: "origin",
      originalValue: { status: "not-found", identifier: "KXXX" },
    });
  });

  it("is idempotent for a repeated identical correction", () => {
    const first = applyProposalCorrection(
      unresolvedRow(),
      {
        origin: {
          status: "resolved",
          identifier: "KSEA",
          airportId: "airport-sea",
          airport,
        },
      },
      "2026-08-12T18:00:00.000Z",
    );
    const second = applyProposalCorrection(
      first,
      { origin: first.proposedFlight.origin },
      "2026-08-12T19:00:00.000Z",
    );
    expect(second.corrections).toEqual(first.corrections);
  });

  it("supports explicitly clearing optional flight metadata", () => {
    const source = unresolvedRow();
    source.proposedFlight.flightNumber = "AS100";
    const patch = validateProposalPatch({ flightNumber: "" });
    const corrected = applyProposalCorrection(
      source,
      patch,
      "2026-08-12T18:00:00.000Z",
    );
    expect(corrected.proposedFlight.flightNumber).toBeUndefined();
    expect(corrected.corrections?.[0]).toMatchObject({
      field: "flightNumber",
      originalValue: "AS100",
      correctedValue: undefined,
    });
  });

  it("rejects malformed dates, times, and unexpected fields", () => {
    expect(() => validateProposalPatch({ date: "2026-02-31" })).toThrow(
      /valid YYYY-MM-DD/,
    );
    expect(() =>
      validateProposalPatch({ departureTime: "25:00" }),
    ).toThrow(/HH:MM/);
    expect(() =>
      validateProposalPatch({ unsafe: "value" } as never),
    ).toThrow(/unsupported/);
  });
});
