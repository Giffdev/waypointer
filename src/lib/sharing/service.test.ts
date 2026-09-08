import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withUserDb: vi.fn(),
  withPublicShareDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
  withUserDb: mocks.withUserDb,
  withPublicShareDb: mocks.withPublicShareDb,
}));

import {
  formatHandleSharePath,
  getPublicMapProjection,
  publicAirportFromRow,
  publicHandleRateLimitKey,
  rollbackCompatibleStoredProjection,
  ShareNotFoundError,
  ShareValidationError,
  toLegacyPublicMapProjection,
  type PublicAirportRow,
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

  it("serializes v4 directions into the previous exact v2 browser shape", () => {
    const canonical: PublicMapProjection = {
      schemaVersion: 4,
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

  it("stores a directional v2 rollback view alongside canonical v4 facts", async () => {
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
      schemaVersion: 4,
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

    // The rollback document is written, never read: nothing on the public
    // path consults it.
  });

  it("derives the public map from the owner's current rows on every request", async () => {
    const { resolve, txExecute } = mockLiveOwner({
      flights: [
        ownerFlight({ id: FLIGHT_ONE }),
        ownerFlight({
          id: FLIGHT_TWO,
          originAirportId: JFK_ID,
          destinationAirportId: SEA_ID,
        }),
      ],
      airports: [seaRow(), jfkRow()],
    });

    const projection = await getPublicMapProjection("devsin");

    expect(projection).toMatchObject({
      schemaVersion: 4,
      owner: { displayName: null },
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
    // The bounded query path: one owner resolution, then exactly three
    // owner-scoped reads regardless of how many flights the owner has.
    expect(resolve).toHaveBeenCalledOnce();
    expect(txExecute).toHaveBeenCalledTimes(3);
  });

  it("keeps the query count flat as the logbook grows", async () => {
    // The guard against a per-flight or per-airport read sneaking back in:
    // fifty flights must cost exactly what two flights cost.
    const { resolve, txExecute } = mockLiveOwner({
      flights: Array.from({ length: 50 }, (_, index) =>
        ownerFlight({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        }),
      ),
      airports: [seaRow(), jfkRow()],
    });

    const projection = await getPublicMapProjection("devsin");

    expect(projection.summary.flightCount).toBe(50);
    expect(resolve).toHaveBeenCalledOnce();
    expect(txExecute).toHaveBeenCalledTimes(3);
  });

  it("reads the live share owner rather than a stored projection document", async () => {
    const { resolve } = mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [seaRow(), jfkRow()],
    });

    await getPublicMapProjection("devsin");

    const { sql: text, params } = new PgDialect().sqlToQuery(
      resolve.mock.calls[0]![0] as SQL,
    );
    expect(text).toContain("public_share_owner_by_handle");
    expect(text).not.toContain("public_map_projection_by_handle");
    expect(params).toEqual(["devsin"]);
  });

  it("serves an existing share handle live, with no republish and no stored fallback", async () => {
    // A handle enabled before this shipped resolves to its owner exactly as a
    // new one does, and the map it serves is derived from the owner's rows
    // right now. There is no stored document in this path to fall back to.
    const first = mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      stops: [
        stop({ flightId: FLIGHT_ONE, airportId: SEA_ID, stopOrder: 0 }),
        stop({ flightId: FLIGHT_ONE, airportId: JFK_ID, stopOrder: 1 }),
      ],
      airports: [seaRow(), jfkRow()],
    });
    const before = await getPublicMapProjection("legacy-handle");
    expect(before.flights[0]).not.toHaveProperty("routePath");
    expect(first.resolve).toHaveBeenCalledOnce();

    // The owner then enriches that same flight with an overflown waypoint.
    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      stops: [
        stop({ flightId: FLIGHT_ONE, airportId: SEA_ID, stopOrder: 0 }),
        stop({
          flightId: FLIGHT_ONE,
          airportId: WAYPOINT_ID,
          stopOrder: 1,
          stopKind: "waypoint",
        }),
        stop({ flightId: FLIGHT_ONE, airportId: JFK_ID, stopOrder: 2 }),
      ],
      airports: [seaRow(), jfkRow(), waypointRow()],
    });

    const after = await getPublicMapProjection("legacy-handle");
    expect(after.flights[0]!.routePath?.map((node) => node.kind)).toEqual([
      "landing",
      "waypoint",
      "landing",
    ]);
    // Geometry only. A waypoint is not a place the pilot went, so nothing it
    // touches may move a count.
    expect(after.summary).toEqual(before.summary);
    expect(after.routes).toHaveLength(before.routes.length);
    expect(
      after.routes.flatMap(({ origin, destination }) => [
        origin.code,
        destination.code,
      ]),
    ).not.toContain("WPT1");
  });

  it("drops a deleted flight from the shared map without a republish", async () => {
    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE }), ownerFlight({ id: FLIGHT_TWO })],
      airports: [seaRow(), jfkRow()],
    });
    expect((await getPublicMapProjection("devsin")).summary.flightCount).toBe(2);

    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [seaRow(), jfkRow()],
    });
    expect((await getPublicMapProjection("devsin")).summary.flightCount).toBe(1);
  });

  it("serves an empty map once the owner has no eligible flights left", async () => {
    // Enabled but empty is a truthful live view, not a broken one: the link
    // stays valid and shows nothing until there is something to show.
    mockLiveOwner({ flights: [], stops: [], airports: [] });

    await expect(getPublicMapProjection("devsin")).resolves.toEqual({
      schemaVersion: 4,
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
      routes: [],
      flights: [],
    });
  });

  it("never reads a private owner column into the public map", async () => {
    const { txExecute } = mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [seaRow(), jfkRow()],
    });

    const projection = await getPublicMapProjection("devsin");

    const { sql: flightQuery } = new PgDialect().sqlToQuery(
      txExecute.mock.calls[0]![0] as SQL,
    );
    // Asserted on the query itself, not just the output: a private column
    // that is never selected cannot leak through a later refactor of the
    // projection shape.
    for (const column of [
      "notes",
      "route_raw",
      "source_row_key",
      "fingerprint",
      "flight_number",
      "airline",
      "departure_time",
      "distance_miles",
      "duration_hours",
      "visibility",
    ]) {
      expect(flightQuery, column).not.toContain(`"${column}"`);
    }
    const serialized = JSON.stringify(projection);
    for (const secret of [FLIGHT_ONE, SEA_ID, JFK_ID, OWNER_ID]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/notes|fingerprint|userId|flightId|email/i);
    expect(projection.owner).toEqual({ displayName: null });
  });

  it("scopes every live read to the resolved share owner", async () => {
    const { txExecute } = mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [seaRow(), jfkRow()],
    });

    await getPublicMapProjection("devsin");

    for (const call of txExecute.mock.calls) {
      const { sql: text, params } = new PgDialect().sqlToQuery(
        call[0] as SQL,
      );
      expect(text).toContain('"user_id" = $1::uuid');
      expect(params[0]).toBe(OWNER_ID);
    }
  });

  it("drops placeholder metadata and bounds live aircraft values", async () => {
    mockLiveOwner({
      flights: [
        ownerFlight({
          id: FLIGHT_ONE,
          aircraftType: "N/A",
          aircraft: "A1",
          registration: "-",
        }),
      ],
      airports: [seaRow(), jfkRow()],
    });

    await expect(getPublicMapProjection("devsin")).resolves.toMatchObject({
      flights: [
        expect.objectContaining({ aircraft: ["A1"], registration: null }),
      ],
    });
  });

  it("uses the owner's current catalog label without a republish", async () => {
    // Bandon State published as `BDY` while the catalog still carried the
    // unused IATA code. A live map reads the catalog row itself, so a release
    // that withholds the code changes the label on the next request.
    mockLiveOwner({
      flights: [
        ownerFlight({ id: FLIGHT_ONE, originAirportId: BANDON_ID }),
      ],
      airports: [bandonRow({ iata: "BDY" }), jfkRow()],
    });
    const published = await getPublicMapProjection("devsin");
    expect(codesByName(published)["Bandon State Airport"]).toBe("BDY");

    mockLiveOwner({
      flights: [
        ownerFlight({ id: FLIGHT_ONE, originAirportId: BANDON_ID }),
      ],
      airports: [bandonRow({ iata: null }), jfkRow()],
    });
    const refreshed = await getPublicMapProjection("devsin");
    expect(codesByName(refreshed)["Bandon State Airport"]).toBe("S05");
  });

  it("accepts legitimate R-number airport identifiers", async () => {
    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [
        seaRow({ iata: null, icao: null, localCode: null, sourceIdent: "R47" }),
        jfkRow(),
      ],
    });

    const result = await getPublicMapProjection("devsin");
    expect([
      result.routes[0]!.origin.code,
      result.routes[0]!.destination.code,
    ]).toContain("R47");
  });

  it("rejects a live flight whose facts cannot be published", async () => {
    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE, kind: "internal" })],
      airports: [seaRow(), jfkRow()],
    });

    await expect(
      getPublicMapProjection("devsin"),
    ).rejects.toBeInstanceOf(ShareValidationError);
  });

  it("rejects a live flight whose airports are missing from the catalog", async () => {
    mockLiveOwner({
      flights: [ownerFlight({ id: FLIGHT_ONE })],
      airports: [seaRow()],
    });

    await expect(
      getPublicMapProjection("devsin"),
    ).rejects.toBeInstanceOf(ShareValidationError);
  });

  it("returns a generic miss for a handle with no enabled share", async () => {
    const resolve = vi.fn().mockResolvedValue([{ ownerId: null }]);
    mocks.getDb.mockReturnValue({ execute: resolve });
    mocks.withPublicShareDb.mockReset();

    await expect(getPublicMapProjection("revoked")).rejects.toBeInstanceOf(
      ShareNotFoundError,
    );
    // Fail-closed: an unresolved handle never opens an owner-scoped read.
    expect(mocks.withPublicShareDb).not.toHaveBeenCalled();
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

const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const FLIGHT_ONE = "00000000-0000-4000-8000-0000000000f1";
const FLIGHT_TWO = "00000000-0000-4000-8000-0000000000f2";
const SEA_ID = "00000000-0000-4000-8000-0000000000e1";
const JFK_ID = "00000000-0000-4000-8000-0000000000e2";
const WAYPOINT_ID = "00000000-0000-4000-8000-0000000000e3";
const BANDON_ID = "00000000-0000-4000-8000-0000000000e4";

type LiveOwnerRows = {
  flights?: unknown[];
  stops?: unknown[];
  airports?: unknown[];
};

/**
 * Drives the live public read: the handle resolves to an owner, and the
 * owner-scoped transaction answers the three row queries in order.
 */
function mockLiveOwner(rows: LiveOwnerRows) {
  const resolve = vi.fn().mockResolvedValue([{ ownerId: OWNER_ID }]);
  mocks.getDb.mockReturnValue({ execute: resolve });
  const txExecute = vi
    .fn()
    .mockResolvedValueOnce(rows.flights ?? [])
    .mockResolvedValueOnce(rows.stops ?? [])
    .mockResolvedValueOnce(rows.airports ?? []);
  mocks.withPublicShareDb.mockReset();
  mocks.withPublicShareDb.mockImplementation(
    async (
      ownerId: string,
      work: (tx: { execute: typeof txExecute }) => Promise<unknown>,
    ) => {
      expect(ownerId).toBe(OWNER_ID);
      return work({ execute: txExecute });
    },
  );
  return { resolve, txExecute };
}

function ownerFlight(overrides: Record<string, unknown> = {}) {
  return {
    id: FLIGHT_ONE,
    date: "2026-08-01",
    kind: "commercial",
    role: "pilot",
    aircraft: null,
    aircraftType: null,
    registration: null,
    originAirportId: SEA_ID,
    destinationAirportId: JFK_ID,
    ...overrides,
  };
}

function stop(overrides: Record<string, unknown> = {}) {
  return {
    flightId: FLIGHT_ONE,
    airportId: SEA_ID,
    stopOrder: 0,
    stopKind: "landing",
    ...overrides,
  };
}

function seaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SEA_ID,
    sourceIdent: "KSEA",
    icao: "KSEA",
    iata: "SEA",
    localCode: "SEA",
    name: "Seattle-Tacoma International Airport",
    city: "Seattle",
    latitude: 47.449,
    longitude: -122.309,
    country: "US",
    facility: "commercial",
    ...overrides,
  };
}

function jfkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JFK_ID,
    sourceIdent: "KJFK",
    icao: "KJFK",
    iata: "JFK",
    localCode: "JFK",
    name: "John F Kennedy International Airport",
    city: "New York",
    latitude: 40.64,
    longitude: -73.779,
    country: "US",
    facility: "commercial",
    ...overrides,
  };
}

function waypointRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WAYPOINT_ID,
    sourceIdent: "WPT1",
    icao: null,
    iata: null,
    localCode: null,
    name: "Overflown waypoint",
    city: "Waypoint",
    latitude: 43.238,
    longitude: -123.356,
    country: "US",
    facility: "general-aviation",
    ...overrides,
  };
}

function bandonRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BANDON_ID,
    sourceIdent: "KS05",
    icao: null,
    iata: "BDY",
    localCode: "S05",
    name: "Bandon State Airport",
    city: "Bandon",
    latitude: BANDON_LAT,
    longitude: BANDON_LON,
    country: "US",
    facility: "general-aviation",
    ...overrides,
  };
}

function codesByName(projection: PublicMapProjection): Record<string, string> {
  return Object.fromEntries(
    projection.routes.flatMap(({ origin, destination }) =>
      [origin, destination].map(({ name, code }) => [name, code]),
    ),
  );
}

const BANDON_LAT = 43.0895;
const BANDON_LON = -124.4158;

describe("publicAirportFromRow display codes", () => {
  function row(overrides: Partial<PublicAirportRow> = {}): PublicAirportRow {
    return {
      sourceIdent: "KSEA",
      icao: "KSEA",
      iata: "SEA",
      localCode: "SEA",
      name: "Seattle-Tacoma International Airport",
      city: "Seattle",
      latitude: 47.456,
      longitude: -122.349,
      country: "US",
      facility: "commercial",
      ...overrides,
    };
  }

  it("keeps the IATA code of a row that carries one", () => {
    expect(publicAirportFromRow(row()).code).toBe("SEA");
    expect(
      publicAirportFromRow(
        row({
          sourceIdent: "VDPP",
          icao: "VDPP",
          iata: "PNH",
          localCode: null,
        }),
      ).code,
    ).toBe("PNH");
  });

  it("falls through to the local code when the catalog withheld IATA", () => {
    expect(
      publicAirportFromRow(
        row({
          sourceIdent: "KS05",
          icao: null,
          iata: null,
          localCode: "S05",
          name: "Bandon State Airport",
          city: "Bandon",
          latitude: BANDON_LAT,
          longitude: BANDON_LON,
          facility: "general-aviation",
        }),
      ).code,
    ).toBe("S05");
  });

  it("rejects a row with no usable identifier rather than inventing one", () => {
    // A row whose identifier columns are all absent must never surface an
    // internal identifier; the projection is rejected instead.
    expect(() =>
      publicAirportFromRow(
        row({ sourceIdent: null, icao: null, iata: null, localCode: null }),
      ),
    ).toThrow(ShareValidationError);
  });
});
