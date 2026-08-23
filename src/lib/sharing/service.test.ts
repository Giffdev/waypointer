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
  rollbackCompatibleStoredProjection,
  ShareRepublishRequiredError,
  ShareValidationError,
  toLegacyPublicMapProjection,
  type PublicMapProjection,
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

  it("serializes v3 directions into the previous exact v2 browser shape", () => {
    const canonical: PublicMapProjection = {
      schemaVersion: 3,
      owner: { displayName: "Pilot" },
      summary: { flightCount: 2, routeCount: 1 },
      routes: [
        {
          id: "canonical",
          kind: "commercial",
          flightCount: 2,
          forwardFlightCount: 1,
          reverseFlightCount: 1,
          directionMode: "both",
          origin: airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309),
          destination: airport(
            "JFK",
            "John F Kennedy",
            "New York",
            "US",
            40.64,
            -73.779,
          ),
        },
      ],
      flights: [
        {
          date: "2026-08-01",
          kind: "commercial",
          role: "passenger",
          aircraft: [],
          registration: null,
          routeLegs: [{ routeId: "canonical", direction: "forward" }],
        },
        {
          date: "2026-08-02",
          kind: "commercial",
          role: "pilot",
          aircraft: [],
          registration: null,
          routeLegs: [{ routeId: "canonical", direction: "reverse" }],
        },
      ],
    };

    const legacy = toLegacyPublicMapProjection(canonical);
    expect(legacy).toMatchObject({
      schemaVersion: 2,
      summary: { flightCount: 2, routeCount: 2 },
    });
    expect(legacy.routes).toHaveLength(2);
    expect(legacy.flights.map(({ routeIds }) => routeIds)).toEqual([
      [legacy.routes[0]!.id],
      [legacy.routes[1]!.id],
    ]);
    expect(Object.keys(legacy.routes[0]!).toSorted()).toEqual(
      ["destination", "flightCount", "id", "kind", "origin"].toSorted(),
    );
    expect(Object.keys(legacy.flights[0]!).toSorted()).toEqual(
      [
        "aircraft",
        "date",
        "kind",
        "registration",
        "role",
        "routeIds",
      ].toSorted(),
    );
  });

  it("stores a directional v2 rollback view alongside canonical v3 facts", async () => {
    const sea = airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309);
    const jfk = airport(
      "JFK",
      "John F Kennedy",
      "New York",
      "US",
      40.64,
      -73.779,
    );
    const canonical: PublicMapProjection = {
      schemaVersion: 3,
      owner: { displayName: "Pilot" },
      summary: { flightCount: 2, routeCount: 1 },
      routes: [
        {
          id: "canonical",
          kind: "commercial",
          flightCount: 2,
          forwardFlightCount: 1,
          reverseFlightCount: 1,
          directionMode: "both",
          origin: sea,
          destination: jfk,
        },
      ],
      flights: [
        {
          date: "2026-08-01",
          kind: "commercial",
          role: "passenger",
          aircraft: [],
          registration: null,
          routeLegs: [{ routeId: "canonical", direction: "forward" }],
        },
        {
          date: "2026-08-02",
          kind: "commercial",
          role: "pilot",
          aircraft: [],
          registration: null,
          routeLegs: [{ routeId: "canonical", direction: "reverse" }],
        },
      ],
    };
    const stored = rollbackCompatibleStoredProjection(canonical) as {
      schemaVersion: number;
      routes: Array<{ id: string; origin: { code: string } }>;
      canonicalRoutes: PublicMapProjection["routes"];
      flights: Array<{
        routeIds: string[];
        routeLegs: PublicMapProjection["flights"][number]["routeLegs"];
      }>;
    };

    expect(stored.schemaVersion).toBe(2);
    expect(stored.routes).toHaveLength(2);
    expect(stored.routes.map(({ origin }) => origin.code)).toEqual([
      "SEA",
      "JFK",
    ]);
    expect(stored.flights.map(({ routeIds }) => routeIds)).toEqual([
      [stored.routes[0]!.id],
      [stored.routes[1]!.id],
    ]);
    expect(stored.canonicalRoutes).toEqual(canonical.routes);
    expect(stored.flights.map(({ routeLegs }) => routeLegs)).toEqual(
      canonical.flights.map(({ routeLegs }) => routeLegs),
    );

    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([{ projection: stored }]),
    });
    await expect(getPublicMapProjection("devsin")).resolves.toEqual(canonical);
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
              forwardFlightCount: 1,
              reverseFlightCount: 0,
              directionMode: "one-way",
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
              routeLegs: [{ routeId: "route-1", direction: "forward" }],
            },
          ],
        },
      },
    ]);
    mocks.getDb.mockReturnValue({ execute });

    await expect(getPublicMapProjection("DeVSiN")).resolves.toEqual({
      schemaVersion: 3,
      owner: { displayName: null },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [
        {
          id: "route-1",
          kind: "private",
          flightCount: 1,
          forwardFlightCount: 1,
          reverseFlightCount: 0,
          directionMode: "one-way",
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
          routeLegs: [{ routeId: "route-1", direction: "forward" }],
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
        routeLegs: [{ routeId: "route-1", direction: "reverse" }],
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
            routes: [route("route-1", 2), route("route-2", 2)],
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

  it("rejects duplicate route ids within one stored flight", async () => {
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            schemaVersion: 2,
            owner: { displayName: null },
            summary: { flightCount: 1, routeCount: 1 },
            canonicalRoutes: [
              {
                id: "route-1",
                kind: "commercial",
                flightCount: 2,
                forwardFlightCount: 2,
                reverseFlightCount: 0,
                directionMode: "one-way",
                origin: airport(
                  "SEA",
                  "Seattle",
                  "Seattle",
                  "US",
                  47.449,
                  -122.309,
                ),
                destination: airport(
                  "JFK",
                  "John F Kennedy",
                  "New York",
                  "US",
                  40.64,
                  -73.779,
                ),
              },
            ],
            flights: [
              {
                date: "2026-08-01",
                kind: "commercial",
                role: "pilot",
                aircraft: [],
                registration: null,
                routeLegs: [
                  { routeId: "route-1", direction: "forward" },
                  { routeId: "route-1", direction: "forward" },
                ],
              },
            ],
          },
        },
      ]),
    });

    await expect(
      getPublicMapProjection("devsin"),
    ).rejects.toBeInstanceOf(ShareValidationError);
  });

  it("normalizes legacy opposite-direction routes without requiring republish", async () => {
    const sea = airport("SEA", "Seattle", "Seattle", "US", 47.449, -122.309);
    const jfk = airport(
      "JFK",
      "John F Kennedy",
      "New York",
      "US",
      40.64,
      -73.779,
    );
    mocks.getDb.mockReturnValue({
      execute: vi.fn().mockResolvedValue([
        {
          projection: {
            schemaVersion: 2,
            owner: { displayName: null },
            summary: { flightCount: 2, routeCount: 2 },
            routes: [
              {
                id: "outbound",
                kind: "commercial",
                flightCount: 1,
                origin: sea,
                destination: jfk,
              },
              {
                id: "return",
                kind: "commercial",
                flightCount: 1,
                origin: jfk,
                destination: sea,
              },
            ],
            flights: [
              {
                date: "2026-08-01",
                kind: "commercial",
                role: "passenger",
                aircraft: [],
                registration: null,
                routeIds: ["outbound"],
              },
              {
                date: "2026-08-02",
                kind: "commercial",
                role: "pilot",
                aircraft: [],
                registration: null,
                routeIds: ["return"],
              },
            ],
          },
        },
      ]),
    });

    await expect(getPublicMapProjection("devsin")).resolves.toMatchObject({
      summary: { flightCount: 2, routeCount: 1 },
      routes: [
        expect.objectContaining({
          flightCount: 2,
          forwardFlightCount: 1,
          reverseFlightCount: 1,
          directionMode: "both",
        }),
      ],
    });
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

    const result = await getPublicMapProjection("devsin");
    expect(
      [result.routes[0]!.origin.code, result.routes[0]!.destination.code],
    ).toContain("R47");
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
