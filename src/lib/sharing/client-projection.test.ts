import { describe, expect, it } from "vitest";
import {
  parsePublicMapProjection,
  PublicMapProjectionValidationError,
} from "./client-projection";

const projection = {
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
};

describe("public map projection parser", () => {
  it("accepts only the coarse public projection contract", () => {
    expect(parsePublicMapProjection(projection)).toEqual(projection);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        accountId: "private-owner",
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });

  it("rejects inconsistent counts and precise coordinates", () => {
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        summary: { flightCount: 2, routeCount: 1 },
      }),
    ).toThrow(PublicMapProjectionValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection,
        routes: [
          {
            ...projection.routes[0],
            origin: { lat: 47.456, lon: -122.3, country: "US" },
          },
        ],
      }),
    ).toThrow(PublicMapProjectionValidationError);
  });
});
