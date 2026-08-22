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
  ShareRepublishRequiredError,
  ShareValidationError,
} from "./service";

function airport(
  code: string,
  name: string,
  city: string,
  country: string,
  lat: number,
  lon: number,
) {
  return {
    code,
    name,
    city,
    country,
    lat,
    lon,
    facility: "commercial" as const,
  };
}

describe("public map sharing contracts", () => {
  it("formats the canonical public username path without a token", () => {
    expect(formatHandleSharePath("devsin")).toBe("/devsin");
    expect(publicHandleRateLimitKey(" DeVSiN ")).toBe("devsin");
  });

  it("returns only approved data from stored projections", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        projection: {
          schemaVersion: 2,
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
                code: "SEA",
                name: "Seattle-Tacoma International Airport",
                city: "Seattle",
                facility: "commercial",
                airportId: "private-origin-id",
              },
              destination: {
                lat: 40.64,
                lon: -73.879,
                country: "US",
                code: "JFK",
                name: "John F Kennedy International Airport",
                city: "New York",
                facility: "commercial",
                airportId: "private-destination-id",
              },
              flightIds: ["private-flight-id"],
            },
          ],
          flights: [
            {
              id: "private-flight-id",
              date: "2026-08-01",
              kind: "private",
              role: "pilot",
              aircraft: ["Cessna 172"],
              registration: "N12345",
              routeIds: ["route-1"],
            },
          ],
        },
      },
    ]);
    mocks.getDb.mockReturnValue({ execute });

    await expect(getPublicMapProjection("DeVSiN")).resolves.toEqual({
      schemaVersion: 2,
      owner: { displayName: null },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [
        {
          id: "route-1",
          kind: "private",
          flightCount: 1,
          origin: airport(
            "SEA",
            "Seattle-Tacoma International Airport",
            "Seattle",
            "US",
            47.456,
            -122.349,
          ),
          destination: airport(
            "JFK",
            "John F Kennedy International Airport",
            "New York",
            "US",
            40.64,
            -73.879,
          ),
        },
      ],
      flights: [
        {
          date: "2026-08-01",
          kind: "private",
          role: "pilot",
          aircraft: ["Cessna 172"],
          registration: "N12345",
          routeIds: ["route-1"],
        },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns only the approved viewer-filter flight facts", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        projection: {
          owner: { displayName: "Devin", email: "private@example.com" },
          schemaVersion: 2,
          summary: { flightCount: 1, routeCount: 1 },
          routes: [
            {
              id: "route-1",
              kind: "commercial",
              flightCount: 1,
              origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
              destination: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
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

  it("drops placeholder metadata and bounds stored aircraft values", async () => {
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            schemaVersion: 2,
            owner: { displayName: null },
            summary: { flightCount: 1, routeCount: 1 },
            routes: [
              {
                id: "route-1",
                kind: "private",
                flightCount: 1,
                origin: airport("SEA", "Seattle", "Seattle", "US", 47.4, -122.3),
                destination: airport("JFK", "New York", "New York", "US", 40.6, -73.8),
              },
            ],
            flights: [
              {
                date: "2026-08-01",
                kind: "private",
                role: "pilot",
                aircraft: [
                  "N/A",
                  "A1",
                  "A2",
                  "A3",
                  "A4",
                  "A5",
                  "A6",
                  "A7",
                  "A8",
                  "A9",
                ],
                registration: "-",
                routeIds: ["route-1"],
              },
            ],
          },
        },
      ]),
    });

    await expect(getPublicMapProjection("devsin")).resolves.toMatchObject({
      flights: [
        expect.objectContaining({
          aircraft: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"],
          registration: null,
        }),
      ],
    });
  });

  it("rejects inconsistent stored flight dimensions", async () => {
    const route = (id: string, flightCount: number) => ({
      id,
      kind: "commercial",
      flightCount,
      origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
      destination: airport("JFK", "John F Kennedy", "New York", "US", 40.64, -73.779),
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
            schemaVersion: 2,
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

    await expect(
      getPublicMapProjection("devsin"),
    ).rejects.toBeInstanceOf(ShareValidationError);
  });

  it("requires old approximate-region projections to be republished", async () => {
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            owner: { displayName: null },
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
          },
        },
      ]),
    });

    await expect(
      getPublicMapProjection("devsin"),
    ).rejects.toBeInstanceOf(ShareRepublishRequiredError);
  });

  it("accepts legitimate R-number airport identifiers", async () => {
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            schemaVersion: 2,
            owner: { displayName: null },
            summary: { flightCount: 1, routeCount: 1 },
            routes: [
              {
                id: "route-1",
                kind: "commercial",
                flightCount: 1,
                origin: airport("R47", "Central Airport", "Central", "US", 47.4, -122.3),
                destination: airport("JFK", "John F Kennedy", "New York", "US", 40.6, -73.8),
              },
            ],
            flights: [
              {
                date: "2026-08-01",
                kind: "commercial",
                role: "pilot",
                aircraft: [],
                registration: null,
                routeIds: ["route-1"],
              },
            ],
          },
        },
      ]),
    });

    await expect(getPublicMapProjection("devsin")).resolves.toMatchObject({
      routes: [
        expect.objectContaining({
          origin: expect.objectContaining({ code: "R47" }),
        }),
      ],
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
