import { describe, expect, it } from "vitest";
import type { Airport, MapRoute } from "./flight-data";
import {
  calculateHomeCamera,
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  clampMapZoom,
  createMapZoomController,
  homeFramePadding,
  initialMapZoomForWidth,
} from "./map-camera";
import { deriveInitialMapFrame } from "./map-framing";

function route(
  origin: Airport,
  destination: Airport,
  flightCount: number,
): MapRoute {
  return {
    id: `${origin.code}-${destination.code}`,
    origin,
    destination,
    flightCount,
    kind: "private",
  };
}

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

function viewportCamera(width: number, height: number) {
  return {
    cameraForBounds: (
      bounds: [[number, number], [number, number]],
      options: {
        bearing: number;
        pitch: number;
        padding: { top: number; right: number; bottom: number; left: number };
        maxZoom: number;
      },
    ) => {
      expect(options.bearing).toBe(0);
      expect(options.pitch).toBe(0);
      const west = bounds[0][0];
      let east = bounds[1][0];
      if (east < west) east += 360;
      const north = Math.max(bounds[0][1], bounds[1][1]);
      const south = Math.min(bounds[0][1], bounds[1][1]);
      const mercatorY = (latitude: number) => {
        const radians = (latitude * Math.PI) / 180;
        return (
          (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
          2
        );
      };
      const longitudeSpan = (east - west) / 360;
      const northY = mercatorY(north);
      const southY = mercatorY(south);
      const availableWidth =
        width - options.padding.left - options.padding.right;
      const availableHeight =
        height - options.padding.top - options.padding.bottom;
      const zoom = Math.min(
        options.maxZoom,
        Math.log2(
          Math.min(
            availableWidth / (longitudeSpan * 512),
            availableHeight / (Math.abs(southY - northY) * 512),
          ),
        ),
      );
      const centerY = (northY + southY) / 2;
      const centerLatitude =
        (Math.atan(Math.sinh(Math.PI * (1 - 2 * centerY))) * 180) / Math.PI;
      return {
        center: { lng: (west + east) / 2, lat: centerLatitude },
        zoom,
      };
    },
  };
}

describe("initial cartographic globe camera", () => {
  it("opens on a complete Atlantic-centered world view", () => {
    expect(DEFAULT_MAP_ZOOM).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_MAP_ZOOM).toBeLessThan(2.5);
    expect(DEFAULT_MAP_CENTER).toEqual([-24, 18]);
  });

  it("keeps the globe fitted on narrow maps while filling laptop map panels", () => {
    expect(initialMapZoomForWidth(390)).toBe(1.65);
    expect(initialMapZoomForWidth(720)).toBe(1.85);
    expect(initialMapZoomForWidth(976)).toBe(DEFAULT_MAP_ZOOM);
    expect(initialMapZoomForWidth(390, 4.2, "regional")).toBeCloseTo(3.55);
    expect(initialMapZoomForWidth(720, 5.5, "local")).toBeCloseTo(5.15);
  });

  it("uses viewport-aware camera fitting for a synthetic home region", () => {
    const sea = airport("SEA", 47.45, -122.31);
    const pdx = airport("PDX", 45.59, -122.6);
    const geg = airport("GEG", 47.62, -117.53);
    const yvr = airport("YVR", 49.19, -123.18);
    const boi = airport("BOI", 43.56, -116.22);
    const frame = deriveInitialMapFrame([
      route(sea, pdx, 42),
      route(sea, geg, 24),
      route(sea, yvr, 18),
      route(sea, boi, 12),
    ]);

    const desktop = calculateHomeCamera(
      viewportCamera(976, 696),
      frame,
      976,
      696,
    );
    const mobile = calculateHomeCamera(
      viewportCamera(390, 490),
      frame,
      390,
      490,
    );

    expect(frame.scope).toBe("regional");
    expect(desktop.zoom).toBeGreaterThan(frame.zoom + 0.8);
    expect(desktop.zoom).toBeLessThanOrEqual(5.1);
    expect(mobile.zoom).toBeGreaterThan(frame.zoom);
    expect(desktop.zoom).toBeGreaterThan(mobile.zoom + 0.5);
    expect(desktop.center[0]).toBeCloseTo(frame.center[0], 1);
    expect(desktop.center[1]).toBeCloseTo(frame.center[1], 0);
  });

  it("derives modest symmetric fit padding from both viewport dimensions", () => {
    expect(homeFramePadding(976, 696)).toEqual({
      top: 5,
      right: 5,
      bottom: 5,
      left: 5,
    });
    expect(homeFramePadding(390, 490)).toEqual({
      top: 4,
      right: 4,
      bottom: 4,
      left: 4,
    });
  });

  it("keeps direct map zoom controls within supported bounds", () => {
    expect(clampMapZoom(-2)).toBe(0);
    expect(clampMapZoom(20)).toBe(18);
    expect(clampMapZoom(4.5)).toBe(4.5);
  });

  it("tracks native wheel zoom without requiring a React state update", () => {
    const controller = createMapZoomController();

    controller.sync(6.4);

    expect(controller.get()).toBe(6.4);
    expect(controller.step(0.75)).toBe(7.15);
  });

  it("clamps button steps and resets the camera snapshot", () => {
    const controller = createMapZoomController(17.8);

    expect(controller.step(0.75)).toBe(18);
    expect(controller.reset()).toBe(DEFAULT_MAP_ZOOM);
    expect(controller.get()).toBe(DEFAULT_MAP_ZOOM);
  });
});
