import { describe, expect, it } from "vitest";
import { airports, type MapRoute } from "./flight-data";
import {
  formatRouteDirection,
  routeDirection,
  routeDirectionDetail,
} from "./route-direction";

const baseRoute: MapRoute = {
  id: "route",
  origin: airports.PAE,
  destination: airports.SEA,
  kind: "private",
  flightCount: 3,
};

describe("route direction", () => {
  it("keeps a known one-way route pointed from origin to destination", () => {
    expect(routeDirection(baseRoute)).toMatchObject({
      mode: "one-way",
      cue: "➤",
      origin: airports.PAE,
      destination: airports.SEA,
    });
    expect(formatRouteDirection(baseRoute)).toBe("PAE ➤ SEA");
  });

  it("reverses reverse-only canonical aggregates", () => {
    const route = {
      ...baseRoute,
      forwardFlightCount: 0,
      reverseFlightCount: 3,
    };

    expect(routeDirection(route)).toMatchObject({
      mode: "one-way",
      cue: "➤",
      origin: airports.SEA,
      destination: airports.PAE,
    });
    expect(formatRouteDirection(route)).toBe("SEA ➤ PAE");
  });

  it("uses a symmetric cue and reports both counts for reciprocal routes", () => {
    const route = {
      ...baseRoute,
      flightCount: 5,
      forwardFlightCount: 3,
      reverseFlightCount: 2,
    };

    expect(routeDirection(route).mode).toBe("reciprocal");
    expect(formatRouteDirection(route)).toBe("PAE ↔ SEA");
    expect(routeDirectionDetail(route)).toBe("3 PAE ➤ SEA · 2 SEA ➤ PAE");
  });

  it("does not invent direction when counts have no directional evidence", () => {
    const route = {
      ...baseRoute,
      forwardFlightCount: 0,
      reverseFlightCount: 0,
    };

    expect(routeDirection(route).mode).toBe("none");
    expect(formatRouteDirection(route)).toBe("PAE — SEA");
    expect(routeDirectionDetail(route)).toBe("Direction unavailable");
  });

  it("does not render a directional cue for same-airport activity", () => {
    const route = {
      ...baseRoute,
      destination: airports.PAE,
      forwardFlightCount: 3,
      reverseFlightCount: 0,
    };

    expect(routeDirection(route).mode).toBe("none");
  });
});
