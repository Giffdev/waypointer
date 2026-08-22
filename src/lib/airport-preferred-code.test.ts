import { describe, expect, it } from "vitest";
import {
  isPublicAirportCode,
  preferredAirportCode,
} from "./airport-preferred-code";

describe("preferred airport code", () => {
  it("uses the private-map preference order with a safe source fallback", () => {
    expect(
      preferredAirportCode({
        iata: "SEA",
        localCode: "SEA-LOCAL",
        icao: "KSEA",
        sourceIdent: "US-0001",
      }),
    ).toBe("SEA");
    expect(
      preferredAirportCode({
        iata: null,
        localCode: null,
        icao: null,
        sourceIdent: "US-0001",
      }),
    ).toBe("US-0001");
  });

  it("accepts real R-number identifiers but never accepts UUID fallback data", () => {
    expect(isPublicAirportCode("R47")).toBe(true);
    expect(
      preferredAirportCode({
        iata: null,
        localCode: null,
        icao: null,
        sourceIdent: null,
      }),
    ).toBeNull();
  });
});
