import {
  zoomLimitsForScope,
  type MapFrame,
  type MapFrameScope,
} from "./map-framing";

export const DEFAULT_MAP_ZOOM = 2.08;
export const MIN_MAP_ZOOM = 0;
export const MAX_MAP_ZOOM = 18;
export const DEFAULT_MAP_CENTER: [number, number] = [-24, 18];
export const MOBILE_MAP_ZOOM = 1.65;

export function clampMapZoom(zoom: number): number {
  return Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, zoom));
}

export function initialMapZoomForWidth(
  width: number,
  requestedZoom = DEFAULT_MAP_ZOOM,
  scope: MapFrameScope = "global",
): number {
  if (scope === "global") {
    if (width < 600) return Math.min(requestedZoom, MOBILE_MAP_ZOOM);
    if (width < 900) return Math.min(requestedZoom, 1.85);
    return requestedZoom;
  }
  const minimumByScope: Record<Exclude<MapFrameScope, "global">, number> = {
    continental: 2.3,
    regional: 3.45,
    local: 4.8,
  };
  if (width < 600) return Math.max(minimumByScope[scope], requestedZoom - 0.65);
  if (width < 900) return Math.max(minimumByScope[scope], requestedZoom - 0.35);
  return requestedZoom;
}

type FitPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type BoundsCamera = {
  cameraForBounds: (
    bounds: MapFrame["bounds"],
    options: {
      bearing: number;
      pitch: number;
      padding: FitPadding;
      maxZoom: number;
    },
  ) =>
    | {
        center?: unknown;
        zoom?: number;
      }
    | undefined;
};

export type MapCameraTarget = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
};

export function homeFramePadding(width: number, height: number): FitPadding {
  const shortestSide = Math.max(0, Math.min(width, height));
  const padding = Math.round(Math.min(6, Math.max(4, shortestSide * 0.0075)));
  return { top: padding, right: padding, bottom: padding, left: padding };
}

export function calculateHomeCamera(
  camera: BoundsCamera,
  frame: MapFrame,
  width: number,
  height: number,
): MapCameraTarget {
  if (frame.scope === "global") {
    return {
      center: frame.center,
      zoom: initialMapZoomForWidth(width, frame.zoom, frame.scope),
      bearing: 0,
      pitch: 0,
    };
  }

  const fitted = camera.cameraForBounds(frame.bounds, {
    bearing: 0,
    pitch: 0,
    padding: homeFramePadding(width, height),
    maxZoom: zoomLimitsForScope(frame.scope)[1],
  });
  const center = fitted ? mapCameraCenter(fitted.center) : undefined;
  if (!fitted || !center || !Number.isFinite(fitted.zoom)) {
    return { center: frame.center, zoom: frame.zoom, bearing: 0, pitch: 0 };
  }
  return {
    center,
    zoom: clampMapZoom(Number(fitted.zoom)),
    bearing: 0,
    pitch: 0,
  };
}

function mapCameraCenter(center: unknown): [number, number] | undefined {
  if (
    Array.isArray(center) &&
    Number.isFinite(center[0]) &&
    Number.isFinite(center[1])
  ) {
    return [Number(center[0]), Number(center[1])];
  }
  if (!center || typeof center !== "object" || !("lat" in center)) return undefined;
  const longitude =
    "lng" in center ? center.lng : "lon" in center ? center.lon : undefined;
  if (!Number.isFinite(longitude) || !Number.isFinite(center.lat)) return undefined;
  return [Number(longitude), Number(center.lat)];
}

export type MapZoomController = {
  get: () => number;
  sync: (zoom: number) => number;
  step: (delta: number) => number;
  reset: (zoom?: number) => number;
};

export function createMapZoomController(
  initialZoom = DEFAULT_MAP_ZOOM,
): MapZoomController {
  let currentZoom = clampMapZoom(initialZoom);

  return {
    get: () => currentZoom,
    sync: (zoom) => {
      currentZoom = clampMapZoom(zoom);
      return currentZoom;
    },
    step: (delta) => {
      currentZoom = clampMapZoom(currentZoom + delta);
      return currentZoom;
    },
    reset: (zoom = DEFAULT_MAP_ZOOM) => {
      currentZoom = clampMapZoom(zoom);
      return currentZoom;
    },
  };
}
