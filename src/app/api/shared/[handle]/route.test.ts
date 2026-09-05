import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  getPublicMapProjection: vi.fn(),
  toLegacyPublicMapProjection: vi.fn(),
  toV3PublicMapProjection: vi.fn(),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  RateLimitExceededError: class RateLimitExceededError extends Error {
    retryAfterSeconds = 30;
  },
}));
vi.mock("@/lib/sharing/service", () => ({
  getPublicMapProjection: mocks.getPublicMapProjection,
  publicHandleRateLimitKey: (handle: string) => handle.toLowerCase(),
  toLegacyPublicMapProjection: mocks.toLegacyPublicMapProjection,
  toV3PublicMapProjection: mocks.toV3PublicMapProjection,
  ShareNotFoundError: class ShareNotFoundError extends Error {},
  ShareRepublishRequiredError: class ShareRepublishRequiredError extends Error {},
}));

import { GET, POST } from "./route";
import {
  ShareNotFoundError,
  ShareRepublishRequiredError,
} from "@/lib/sharing/service";

describe("public shared map API", () => {
  beforeEach(() => {
    mocks.consumeRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.getPublicMapProjection.mockReset().mockResolvedValue({
      schemaVersion: 4,
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
      routes: [],
      flights: [],
    });
    mocks.toLegacyPublicMapProjection
      .mockReset()
      .mockReturnValue({
        schemaVersion: 2,
        owner: { displayName: null },
        summary: { flightCount: 0, routeCount: 0 },
        routes: [],
        flights: [],
      });
    mocks.toV3PublicMapProjection
      .mockReset()
      .mockReturnValue({
        schemaVersion: 3,
        owner: { displayName: null },
        summary: { flightCount: 0, routeCount: 0 },
        routes: [],
        flights: [],
      });
  });

  it("keeps the default endpoint on the rollback-compatible v2 contract", async () => {
    const response = await GET(
      new Request("https://example.test/api/shared/devsin"),
      { params: Promise.resolve({ handle: "devsin" }) },
    );

    expect((await response.json()).map.schemaVersion).toBe(2);
    expect(mocks.toLegacyPublicMapProjection).toHaveBeenCalledOnce();
    expect(mocks.toV3PublicMapProjection).not.toHaveBeenCalled();
  });

  it("treats an unrecognised contract value the same as no contract at all", async () => {
    const response = await GET(
      new Request("https://example.test/api/shared/devsin?contract=5"),
      { params: Promise.resolve({ handle: "devsin" }) },
    );

    expect((await response.json()).map.schemaVersion).toBe(2);
    expect(mocks.toLegacyPublicMapProjection).toHaveBeenCalledOnce();
    expect(mocks.toV3PublicMapProjection).not.toHaveBeenCalled();
  });

  it("downgrades a freshly republished waypoint snapshot to the frozen contract=3 shape", async () => {
    const canonical = {
      schemaVersion: 4,
      owner: { displayName: "Waypoint Pilot" },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [],
      flights: [
        {
          date: "2026-08-14",
          kind: "private",
          role: "pilot",
          aircraft: ["Cessna 172"],
          registration: "N12345",
          routePath: [
            { airport: airport("S05", "Bandon State", "Bandon", "US", 43, -124.4), kind: "landing" },
            { airport: airport("KRBG", "Roseburg Regional", "Roseburg", "US", 43.2, -123.3), kind: "waypoint" },
            { airport: airport("S05", "Bandon State", "Bandon", "US", 43, -124.4), kind: "landing" },
          ],
          routeLegs: [],
        },
      ],
    };
    mocks.getPublicMapProjection.mockResolvedValueOnce(canonical);
    const v3 = {
      schemaVersion: 3,
      owner: canonical.owner,
      summary: canonical.summary,
      routes: canonical.routes,
      flights: [
        {
          date: "2026-08-14",
          kind: "private",
          role: "pilot",
          aircraft: ["Cessna 172"],
          registration: "N12345",
          routeLegs: [],
        },
      ],
    };
    mocks.toV3PublicMapProjection.mockReturnValueOnce(v3);

    const response = await GET(
      new Request("https://example.test/api/shared/devsin?contract=3"),
      { params: Promise.resolve({ handle: "devsin" }) },
    );

    expect(mocks.toV3PublicMapProjection).toHaveBeenCalledWith(canonical);
    expect(mocks.toLegacyPublicMapProjection).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.map).toEqual(v3);
    expect(body.map.flights[0]).not.toHaveProperty("routePath");
    // The stale-client contract stays a plain six-key flight shape, never
    // a seventh key that its already-shipped exact-key parser would reject.
    expect(Object.keys(body.map.flights[0]).toSorted()).toEqual(
      [
        "date",
        "kind",
        "role",
        "aircraft",
        "registration",
        "routeLegs",
      ].toSorted(),
    );
  });

  it("serves the canonical waypoint-aware contract=4 response unmodified", async () => {
    mocks.getPublicMapProjection.mockResolvedValueOnce({
      schemaVersion: 4,
      owner: { displayName: "Public Pilot" },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [],
      flights: [
        {
          date: "2026-08-14",
          kind: "private",
          role: "pilot",
          aircraft: ["Cessna 172"],
          registration: "N12345",
          routePath: [
            { airport: airport("S05", "Bandon State", "Bandon", "US", 43, -124.4), kind: "landing" },
            { airport: airport("KRBG", "Roseburg Regional", "Roseburg", "US", 43.2, -123.3), kind: "waypoint" },
            { airport: airport("S05", "Bandon State", "Bandon", "US", 43, -124.4), kind: "landing" },
          ],
          routeLegs: [],
        },
      ],
    });

    const response = await GET(
      new Request("https://example.test/api/shared/devsin?contract=4"),
      { params: Promise.resolve({ handle: "devsin" }) },
    );

    expect(mocks.toV3PublicMapProjection).not.toHaveBeenCalled();
    expect(mocks.toLegacyPublicMapProjection).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.map.schemaVersion).toBe(4);
    expect(body.map.flights[0].routePath).toHaveLength(3);
  });

  it("returns public filter facts without account or session metadata", async () => {
    mocks.getPublicMapProjection.mockResolvedValueOnce({
      schemaVersion: 4,
      owner: { displayName: "Public Pilot" },
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
            47.44898,
            -122.30931,
          ),
          destination: airport(
            "JFK",
            "John F Kennedy International Airport",
            "New York",
            "US",
            40.63993,
            -73.77869,
          ),
        },
      ],
      flights: [
        {
          date: "2026-08-14",
          kind: "private",
          role: "pilot",
          aircraft: ["Cessna 172"],
          registration: "N12345",
          routeLegs: [{ routeId: "route-1", direction: "forward" }],
        },
      ],
    });
    const response = await GET(
      new Request("https://example.test/api/shared/devsin?contract=4"),
      { params: Promise.resolve({ handle: "devsin" }) },
    );
    const body = await response.json();
    expect(body.map.flights).toEqual([
      {
        date: "2026-08-14",
        kind: "private",
        role: "pilot",
        aircraft: ["Cessna 172"],
        registration: "N12345",
        routeLegs: [{ routeId: "route-1", direction: "forward" }],
      },
    ]);
    expect(body.map.routes[0].origin).toMatchObject({
      code: "SEA",
      name: "Seattle-Tacoma International Airport",
      city: "Seattle",
    });
    expect(body.map.routes[0]).toMatchObject({
      forwardFlightCount: 1,
      reverseFlightCount: 0,
      directionMode: "one-way",
    });
    expect(JSON.stringify(body)).not.toMatch(/"code":"R\d+"/);
    expect(JSON.stringify(body)).not.toMatch(
      /email|session|accountId|userId|notes|fingerprint|flightId/i,
    );
  });

  it("tells viewers when an old projection must be republished", async () => {
    mocks.getPublicMapProjection.mockRejectedValueOnce(
      new ShareRepublishRequiredError(),
    );
    const response = await GET(
      new Request("https://example.test/api/shared/legacy"),
      { params: Promise.resolve({ handle: "legacy" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "republish-required",
        message: "This shared map must be republished to show real airports.",
      },
    });
  });

  it("reads a public username with no token and no-store caching", async () => {
    const response = await GET(
      new Request("https://example.test/api/shared/DeVSiN", {
        headers: { "x-real-ip": "192.0.2.1" },
      }),
      { params: Promise.resolve({ handle: "DeVSiN" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "no-store, max-age=0, s-maxage=0, must-revalidate",
    );
    expect(mocks.getPublicMapProjection).toHaveBeenCalledWith("DeVSiN");
    expect(mocks.consumeRateLimit.mock.calls).toEqual([
      ["public-map-ip", "192.0.2.1", 120, 60_000],
      ["public-map-handle", "devsin:192.0.2.1", 10, 60_000],
    ]);
  });

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

  it("returns the same generic 404 for disabled and unknown handles", async () => {
    mocks.getPublicMapProjection.mockRejectedValueOnce(new ShareNotFoundError());
    const response = await GET(
      new Request("https://example.test/api/shared/unknown"),
      { params: Promise.resolve({ handle: "unknown" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: { code: "not-found", message: "Waypointer shared map not found." },
    });
  });

  it("does not accept a legacy POST capability body", async () => {
    const response = await POST();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
