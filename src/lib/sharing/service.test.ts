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

  it("returns only aggregate route data from stored projections", async () => {
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
                lat: 47.4,
                lon: -122.3,
                country: "US",
                airportCode: "SEA",
              },
              destination: {
                lat: 40.6,
                lon: -73.8,
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
          origin: { lat: 47.4, lon: -122.3, country: "US" },
          destination: { lat: 40.6, lon: -73.8, country: "US" },
        },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
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
