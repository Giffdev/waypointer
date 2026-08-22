import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withUserDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
  withUserDb: mocks.withUserDb,
}));

import {
  formatHandleSharePath,
  getPublicMapProjection,
  publicHandleRateLimitKey,
} from "./service";

describe("public map sharing contracts", () => {
  it("formats the canonical public username path without a token", () => {
    expect(formatHandleSharePath("devsin")).toBe("/devsin");
    expect(publicHandleRateLimitKey(" DeVSiN ")).toBe("devsin");
  });

  it("returns only approved data from stored projections", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        projection: {
          owner: { displayName: null, accountId: "private-owner-id" },
          summary: { flightCount: 1, routeCount: 1, importedRows: 2 },
          routes: [
            {
              id: "route-1",
              kind: "private",
              flightCount: 1,
              origin: {
                lat: 47.456,
                lon: -122.349,
                country: "US",
                airportCode: "SEA",
              },
              destination: {
                lat: 40.64,
                lon: -73.879,
                country: "US",
                airportCode: "JFK",
              },
              flightIds: ["private-flight-id"],
            },
          ],
          flights: [{ id: "private-flight-id" }],
        },
      },
    ]);
    mocks.getDb.mockReturnValue({ execute });

    await expect(getPublicMapProjection("DeVSiN")).resolves.toEqual({
      owner: { displayName: null },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [
        {
          id: "route-1",
          kind: "private",
          flightCount: 1,
          origin: { lat: 47.5, lon: -122.3, country: "US" },
          destination: { lat: 40.6, lon: -73.9, country: "US" },
        },
      ],
      flights: null,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns only the approved viewer-filter flight facts", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        projection: {
          owner: { displayName: "Devin", email: "private@example.com" },
          summary: { flightCount: 1, routeCount: 1 },
          routes: [
            {
              id: "route-1",
              kind: "commercial",
              flightCount: 1,
              origin: { lat: 47.4, lon: -122.3, country: "US" },
              destination: { lat: 40.6, lon: -73.8, country: "US" },
            },
          ],
          flights: [
            {
              date: "2026-08-01",
              kind: "commercial",
              role: "pilot",
              aircraft: ["Boeing 737"],
              registration: "N12345",
              routeIds: ["route-1"],
              id: "private-flight-id",
              notes: "private notes",
              userId: "private-owner-id",
            },
          ],
        },
      },
    ]);
    mocks.getDb.mockReturnValue({ execute });

    const result = await getPublicMapProjection("devsin");
    expect(result.flights).toEqual([
      {
        date: "2026-08-01",
        kind: "commercial",
        role: "pilot",
        aircraft: ["Boeing 737"],
        registration: "N12345",
        routeIds: ["route-1"],
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private-flight-id|private notes|private-owner-id|private@example\.com/,
    );
  });

  it("degrades inconsistent stored flight dimensions to a legacy view", async () => {
    const route = (id: string, flightCount: number) => ({
      id,
      kind: "commercial",
      flightCount,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 40.6, lon: -73.8, country: "US" },
    });
    const flight = (routeIds: string[]) => ({
      date: "2026-08-01",
      kind: "commercial",
      role: "pilot",
      aircraft: [],
      registration: null,
      routeIds,
    });
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            owner: { displayName: null },
            summary: { flightCount: 2, routeCount: 2 },
            routes: [route("route-1", 2), route("route-2", 1)],
            flights: [
              flight(["route-1"]),
              flight(["route-2", "route-2"]),
            ],
          },
        },
      ]),
    });

    await expect(getPublicMapProjection("devsin")).resolves.toMatchObject({
      flights: null,
    });
  });

  it("rejects reserved roots and UUID identifiers before querying", async () => {
    const execute = vi.fn();
    mocks.getDb.mockReturnValue({ execute });

    await expect(getPublicMapProjection("settings")).rejects.toBeInstanceOf(
      Error,
    );
    await expect(
      getPublicMapProjection("00000000-0000-4000-8000-000000000010"),
    ).rejects.toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
  });
});
