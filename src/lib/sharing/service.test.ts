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
  formatSharePath,
  getPublicMapProjection,
  parseShareSettings,
  publicTokenRateLimitKey,
  ShareValidationError,
} from "./service";

describe("map sharing contracts", () => {
  it("accepts only the identity choice and rejects caller flight selection", () => {
    expect(() => parseShareSettings({})).toThrowError(
      ShareValidationError,
    );
    expect(parseShareSettings({
      includeDisplayName: false,
    })).toEqual({
      includeDisplayName: false,
    });
    expect(() =>
      parseShareSettings({
        flightIds: [],
        includeDisplayName: false,
      }),
    ).toThrowError(ShareValidationError);
    expect(() =>
      parseShareSettings({
        flightIds: ["00000000-0000-4000-8000-000000000001"],
        includeDisplayName: false,
      }),
    ).toThrowError(ShareValidationError);
  });

  it("uses a redacted operational rate-limit key", () => {
    const secret = "s".repeat(43);
    const key = publicTokenRateLimitKey(
      "00000000-0000-4000-8000-000000000010",
      secret,
    );
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain(secret);
  });

  it("places the capability secret only in the non-transmitted URL fragment", () => {
    const publicId = "00000000-0000-4000-8000-000000000010";
    const secret = "s".repeat(43);
    const url = new URL(formatSharePath(publicId, secret), "https://example.test");
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(secret);
    expect(url.hash).toBe(`#key=${secret}`);
  });

  it("returns only aggregate route data from legacy stored projections", async () => {
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
          flights: [
            {
              id: "public-flight-id",
              kind: "private",
              legs: [],
            },
          ],
        },
      },
    ]);
    mocks.getDb.mockReturnValue({ execute });

    const projection = await getPublicMapProjection(
      "00000000-0000-4000-8000-000000000010",
      "s".repeat(43),
    );

    expect(projection).toEqual({
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
    expect(projection).not.toHaveProperty("flights");
  });
});
