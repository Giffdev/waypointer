import { describe, expect, it } from "vitest";
import type { Airport, MapRoute } from "./flight-data";
import { deriveInitialMapFrame, WORLD_MAP_FRAME } from "./map-framing";

function airport(code: string, lat: number, lon: number): Airport {
  return {
    code,
    name: code,
    city: code,
    country: "Synthetic",
    lat,
    lon,
    facility: "commercial",
  };
}

function route(
  origin: Airport,
  destination: Airport,
  flightCount = 1,
  id = `${origin.code}-${destination.code}`,
): MapRoute {
  return { id, origin, destination, flightCount, kind: "private" };
}

const SEA = airport("SEA", 47.45, -122.31);
const PDX = airport("PDX", 45.59, -122.6);
const GEG = airport("GEG", 47.62, -117.53);
const PAE = airport("PAE", 47.91, -122.28);
const LHR = airport("LHR", 51.47, -0.45);
const CDG = airport("CDG", 49.01, 2.55);
const AMS = airport("AMS", 52.31, 4.76);
const FRA = airport("FRA", 50.04, 8.56);
const MAD = airport("MAD", 40.47, -3.56);
const FCO = airport("FCO", 41.8, 12.25);
const JFK = airport("JFK", 40.64, -73.78);
const NRT = airport("NRT", 35.77, 140.39);
const SYD = airport("SYD", -33.95, 151.18);
const DXB = airport("DXB", 25.25, 55.36);
const GRU = airport("GRU", -23.44, -46.47);
const JNB = airport("JNB", -26.14, 28.25);

describe("personalized initial map framing", () => {
  it("focuses Washington-heavy activity while excluding sparse global outliers", () => {
    const frame = deriveInitialMapFrame([
      route(SEA, PDX, 42),
      route(SEA, GEG, 24),
      route(PAE, SEA, 18),
      route(SEA, LHR),
      route(JFK, NRT),
    ]);

    expect(["local", "regional"]).toContain(frame.scope);
    expect(frame.center[0]).toBeLessThan(-115);
    expect(frame.center[1]).toBeGreaterThan(44);
    expect(frame.zoom).toBeGreaterThanOrEqual(3.45);
    expect(frame.bounds[1][0] - frame.bounds[0][0]).toBeLessThan(30);
  });

  it("opens a Europe-heavy history on Europe", () => {
    const frame = deriveInitialMapFrame([
      route(LHR, CDG, 35),
      route(AMS, FRA, 20),
      route(MAD, FCO, 14),
      route(LHR, JFK),
    ]);

    expect(frame.scope).not.toBe("global");
    expect(frame.center[0]).toBeGreaterThan(-20);
    expect(frame.center[0]).toBeLessThan(25);
    expect(frame.center[1]).toBeGreaterThan(35);
  });

  it("prefers a world view for genuinely global, multimodal activity", () => {
    expect(
      deriveInitialMapFrame([
        route(SEA, JFK, 4),
        route(LHR, DXB, 4),
        route(SYD, NRT, 4),
        route(GRU, JNB, 4),
      ]),
    ).toEqual(WORLD_MAP_FRAME);
  });

  it("uses a narrow antimeridian-crossing frame instead of spanning the world", () => {
    const frame = deriveInitialMapFrame([
      route(airport("NAN", -17.76, 177.44), airport("APW", -13.83, -171.99), 20),
      route(airport("TBU", -21.24, -175.15), airport("SUV", -18.04, 178.56), 12),
    ]);

    expect(frame.scope).not.toBe("global");
    expect(Math.abs(frame.center[0])).toBeGreaterThan(160);
    expect(frame.bounds[1][0] - frame.bounds[0][0]).toBeLessThan(30);
  });

  it("falls back safely for empty and sparse histories", () => {
    expect(deriveInitialMapFrame([])).toEqual(WORLD_MAP_FRAME);
    const frame = deriveInitialMapFrame([route(SEA, PDX)]);
    expect(frame.scope).toBe("local");
    expect(frame.zoom).toBeGreaterThanOrEqual(4.8);
    expect(frame.zoom).toBeLessThanOrEqual(7);
  });

  it("deduplicates normalized direction records and weights frequency meaningfully", () => {
    const surrounding = [
      route(LHR, CDG),
      route(JFK, NRT),
      route(SYD, DXB),
    ];
    const unweighted = deriveInitialMapFrame([
      route(SEA, PDX),
      ...surrounding,
    ]);
    const weighted = deriveInitialMapFrame([
      route(SEA, PDX, 64, "primary"),
      route(SEA, PDX, 64, "duplicate"),
      ...surrounding,
    ]);
    const singleWeighted = deriveInitialMapFrame([
      route(SEA, PDX, 64, "primary"),
      ...surrounding,
    ]);

    expect(unweighted.scope).toBe("global");
    expect(weighted.scope).toBe("local");
    expect(weighted).toEqual(singleWeighted);
  });

  it("returns deterministic output regardless of route order", () => {
    const routes = [
      route(SEA, PDX, 42),
      route(SEA, GEG, 24),
      route(PAE, SEA, 18),
      route(SEA, LHR),
    ];
    expect(deriveInitialMapFrame(routes)).toEqual(
      deriveInitialMapFrame([...routes].reverse()),
    );
  });
});
