import { describe, expect, it } from "vitest";
import { airports } from "../flight-data";
import { createFileFingerprint, createRowFingerprint } from "./fingerprint";
import type { ProposedImportFlight } from "./types";

const proposed: ProposedImportFlight = {
  date: "2026-08-11",
  departureTime: "08:05",
  originIdentifier: "SEA",
  destinationIdentifier: "JFK",
  origin: {
    status: "resolved",
    identifier: "SEA",
    airportId: "airport-sea",
    airport: airports.SEA,
  },
  destination: {
    status: "resolved",
    identifier: "JFK",
    airportId: "airport-jfk",
    airport: airports.JFK,
  },
  kind: "commercial",
  role: "passenger",
  flightNumber: "dl 123",
  registration: "N123AB",
  source: "FlightRadar24",
};

describe("versioned import fingerprints", () => {
  it("is deterministic while remaining scoped to one user", () => {
    expect(createFileFingerprint("user-a", "csv")).toEqual(
      createFileFingerprint("user-a", "csv"),
    );
    expect(createFileFingerprint("user-a", "csv").value).not.toBe(
      createFileFingerprint("user-b", "csv").value,
    );
    expect(createRowFingerprint("user-a", proposed)).toEqual(
      createRowFingerprint("user-a", {
        ...proposed,
        flightNumber: " DL   123 ",
      }),
    );
    expect(createRowFingerprint("user-a", proposed)?.value).not.toBe(
      createRowFingerprint("user-b", proposed)?.value,
    );
  });

  it("does not fingerprint unresolved rows", () => {
    expect(
      createRowFingerprint("user-a", {
        ...proposed,
        origin: { status: "not-found", identifier: "UNKNOWN" },
      }),
    ).toBeUndefined();
  });
});
