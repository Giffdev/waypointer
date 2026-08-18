export const DISTANCE_UNITS = [
  "miles",
  "kilometers",
  "nautical_miles",
] as const;

export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

export const DEFAULT_DISTANCE_UNIT: DistanceUnit = "nautical_miles";

const labels: Record<DistanceUnit, string> = {
  miles: "mi",
  kilometers: "km",
  nautical_miles: "NM",
};

export function convertDistanceMiles(
  distanceMiles: number,
  unit: DistanceUnit,
): number {
  if (unit === "kilometers") return distanceMiles * 1.609344;
  if (unit === "nautical_miles") return distanceMiles / 1.150779448;
  return distanceMiles;
}

export function formatDistanceForUnit(
  distanceMiles: number,
  unit: DistanceUnit,
): string {
  return `${Math.round(convertDistanceMiles(distanceMiles, unit)).toLocaleString()} ${labels[unit]}`;
}

export function distanceUnitLabel(unit: DistanceUnit): string {
  return labels[unit];
}
