import { describe, expect, it } from "vitest";
import {
  airportLabelLimit,
  getRouteVisualEncoding,
  mapMaximumPixelRatio,
  routeCurvePointCount,
  routeFrequencyBand,
  routeFrequencyStrength,
  shouldRenderRouteSegment,
} from "./map-visualization";

describe("map route visual encoding", () => {
  it("uses a deterministic logarithmic frequency scale", () => {
    expect(routeFrequencyStrength(1, 41)).toBe(0);
    expect(routeFrequencyStrength(41, 41)).toBe(1);
    expect(routeFrequencyStrength(7, 41)).toBeCloseTo(0.524, 2);
  });

  it("makes frequently flown routes more opaque and prominent", () => {
    const rare = getRouteVisualEncoding("commercial", 1, 41);
    const frequent = getRouteVisualEncoding("commercial", 41, 41);

    expect(frequent.opacity).toBeGreaterThan(rare.opacity);
    expect(frequent.lineWidth).toBeGreaterThan(rare.lineWidth);
    expect(frequent.color).not.toBe(rare.color);
    expect(rare.band).toBe("rare");
    expect(frequent.band).toBe("frequent");
  });

  it("distinguishes personal routes with a non-color dash cue", () => {
    expect(getRouteVisualEncoding("private", 7, 41).dashed).toBe(true);
    expect(getRouteVisualEncoding("commercial", 7, 41).dashed).toBe(false);
  });

  it("assigns understandable legend bands at stable thresholds", () => {
    expect([1, 2, 3, 9, 10].map(routeFrequencyBand)).toEqual([
      "rare",
      "rare",
      "regular",
      "regular",
      "frequent",
    ]);
  });

  it("reduces curve and label density for large local artifacts", () => {
    expect(routeCurvePointCount(243)).toBe(20);
    expect(routeCurvePointCount(80)).toBe(28);
    expect(routeCurvePointCount(10)).toBe(40);
    expect(airportLabelLimit(243)).toBe(0);
    expect(mapMaximumPixelRatio(243)).toBe(1);
    expect(mapMaximumPixelRatio(80)).toBe(1.25);
    expect(mapMaximumPixelRatio(10)).toBe(1.5);
  });

  it("preserves a non-color dash cue when private routes are batched", () => {
    expect([0, 1, 2, 3, 4, 5].filter((index) => shouldRenderRouteSegment("private", index))).toEqual([
      0,
      1,
      3,
      4,
    ]);
    expect(shouldRenderRouteSegment("commercial", 2)).toBe(true);
  });
});
