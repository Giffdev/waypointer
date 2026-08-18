import type { FlightKind } from "./flight-data";

export type RouteFrequencyBand = "rare" | "regular" | "frequent";

export type RouteVisualEncoding = {
  opacity: number;
  lineWidth: number;
  color: string;
  dashed: boolean;
  band: RouteFrequencyBand;
};

const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, value));

export function routeFrequencyStrength(flightCount: number, maximumCount: number): number {
  const count = Math.max(1, flightCount);
  const maximum = Math.max(1, maximumCount);
  if (maximum === 1) return 1;
  return clamp(Math.log(count) / Math.log(maximum));
}

export function routeFrequencyBand(flightCount: number): RouteFrequencyBand {
  if (flightCount <= 2) return "rare";
  if (flightCount <= 9) return "regular";
  return "frequent";
}

export function getRouteVisualEncoding(
  kind: FlightKind,
  flightCount: number,
  maximumCount: number,
): RouteVisualEncoding {
  const strength = routeFrequencyStrength(flightCount, maximumCount);
  const hue = kind === "commercial" ? 174 : 40;
  const saturation = Math.round((kind === "commercial" ? 48 : 58) + strength * 38);
  const lightness = Math.round((kind === "commercial" ? 44 : 50) + strength * 14);

  return {
    opacity: Number((0.2 + strength * 0.76).toFixed(3)),
    lineWidth: Number(((kind === "commercial" ? 1.35 : 1.15) + strength * 2.1).toFixed(2)),
    color: `hsl(${hue} ${saturation}% ${lightness}%)`,
    dashed: kind === "private",
    band: routeFrequencyBand(flightCount),
  };
}

export function routeCurvePointCount(routeCount: number): number {
  if (routeCount >= 150) return 20;
  if (routeCount >= 60) return 28;
  return 40;
}

export function shouldRenderRouteSegment(kind: FlightKind, segmentIndex: number): boolean {
  return kind === "commercial" || segmentIndex % 3 !== 2;
}

export function airportLabelLimit(routeCount: number): number {
  if (routeCount >= 150) return 0;
  if (routeCount >= 60) return 12;
  return 16;
}

export function mapMaximumPixelRatio(routeCount: number): number {
  if (routeCount >= 150) return 1;
  if (routeCount >= 60) return 1.25;
  return 1.5;
}
