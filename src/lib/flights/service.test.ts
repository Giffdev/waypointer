import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { InMemoryImportRepository } from "../import/in-memory-repository";
import {
  createManualFlight,
  FlightServiceError,
  validateManualFlightRequest,
} from "./service";

const originId = "00000000-0000-4000-8000-000000000001";
const destinationId = "00000000-0000-4000-8000-000000000002";
const airport = (code: string): Airport => ({
  code,
  name: code,
  city: "Test",
  country: "US",
  lat: 40,
  lon: -75,
  facility: "general-aviation",
});

function repository() {
  return new InMemoryImportRepository([
    { id: originId, airport: airport("KAAA"), aliases: ["KAAA"] },
    { id: destinationId, airport: airport("KBBB"), aliases: ["KBBB"] },
  ]);
}

const request = {
  classification: "personal" as const,
  date: "2026-08-14",
  originAirportId: originId,
  destinationAirportId: destinationId,
  departureTime: "8:05",
  durationHours: 0,
  aircraft: "Cessna 172",
};

describe("manual flight service", () => {
  it("requires an explicit personal or commercial classification", () => {
    expect(() =>
      validateManualFlightRequest({ ...request, classification: undefined }),
    ).toThrowError(FlightServiceError);
  });

  it.each([
    ["personal", "private", "pilot"],
    ["commercial", "commercial", "passenger"],
  ] as const)("creates a tenant-scoped %s flight", async (
    classification,
    kind,
    role,
  ) => {
    const store = repository();
    const flight = await createManualFlight(
      "user-a",
      { ...request, classification },
      store,
    );
    expect(flight).toMatchObject({
      kind,
      role,
      source: "Manual",
      durationHours: 0,
      departureTime: "08:05:00",
    });
    expect(await store.listFlights("user-b")).toEqual([]);
  });

  it("rejects a duplicate for one tenant but permits the same flight for another", async () => {
    const store = repository();
    await createManualFlight("user-a", request, store);
    await expect(createManualFlight("user-a", request, store)).rejects.toMatchObject({
      status: 409,
      code: "duplicate-flight",
    });
    await expect(createManualFlight("user-b", request, store)).resolves.toMatchObject({
      source: "Manual",
    });
  });
});
