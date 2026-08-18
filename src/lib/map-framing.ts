import type { Airport, MapRoute } from "./flight-data";

export type MapFrameScope = "global" | "continental" | "regional" | "local";

export type MapFrame = {
  center: [number, number];
  zoom: number;
  bounds: [[number, number], [number, number]];
  scope: MapFrameScope;
  confidence: number;
};

export const WORLD_MAP_FRAME: MapFrame = {
  center: [-24, 18],
  zoom: 2.08,
  bounds: [[-180, -70], [180, 80]],
  scope: "global",
  confidence: 0,
};

const SCOPE_ZOOM_LIMITS: Record<MapFrameScope, [number, number]> = {
  global: [1.7, 2.25],
  continental: [2.3, 3.45],
  regional: [3.45, 5.1],
  local: [4.8, 7],
};

const HOME_REGION_CANDIDATES = [
  { radiusKm: 700, minimumCoverage: 0.58 },
  { radiusKm: 1_600, minimumCoverage: 0.6 },
  { radiusKm: 3_200, minimumCoverage: 0.72 },
] as const;

type WeightedPoint = {
  key: string;
  lat: number;
  lon: number;
  weight: number;
};

/**
 * Finds the smallest endpoint-density region that clears a weighted coverage
 * threshold. Route frequency is logarithmically weighted, so repetition matters
 * without allowing one shuttle to erase meaningful surrounding activity.
 * Outliers are excluded only after a dominant region is established.
 */
export function deriveInitialMapFrame(routes: readonly MapRoute[]): MapFrame {
  const points = weightedEndpoints(routes);
  if (points.length === 0) return WORLD_MAP_FRAME;
  if (points.length <= 2) return frameSparseHistory(points);

  const totalWeight = points.reduce((total, point) => total + point.weight, 0);
  let selected: WeightedPoint[] | undefined;
  let confidence = 0;

  for (const candidate of HOME_REGION_CANDIDATES) {
    const densest = points
      .map((center) => {
        const members = points.filter(
          (point) => greatCircleKm(center, point) <= candidate.radiusKm,
        );
        return {
          center,
          members,
          coverage:
            members.reduce((total, point) => total + point.weight, 0) /
            totalWeight,
        };
      })
      .filter(({ members }) => members.length >= 2)
      .sort(
        (left, right) =>
          right.coverage - left.coverage ||
          left.center.key.localeCompare(right.center.key),
      )[0];

    if (!densest || densest.coverage < candidate.minimumCoverage) continue;
    selected = points.filter(
      (point) =>
        greatCircleKm(densest.center, point) <= candidate.radiusKm * 1.25,
    );
    confidence = densest.coverage;
    break;
  }

  if (!selected) return WORLD_MAP_FRAME;
  const diameterKm = geographicDiameterKm(selected);
  const scope: MapFrameScope =
    diameterKm <= 500
      ? "local"
      : diameterKm <= 1_800
        ? "regional"
        : "continental";
  return framePoints(selected, scope, confidence);
}

export function zoomLimitsForScope(scope: MapFrameScope): [number, number] {
  return SCOPE_ZOOM_LIMITS[scope];
}

function weightedEndpoints(routes: readonly MapRoute[]): WeightedPoint[] {
  const directionalRoutes = new Map<
    string,
    { origin: Airport; destination: Airport; flightCount: number }
  >();

  for (const route of routes) {
    if (!mapSafeAirport(route.origin) || !mapSafeAirport(route.destination)) continue;
    const key = `${route.kind}:${airportKey(route.origin)}>${airportKey(route.destination)}`;
    const flightCount = Math.max(1, Math.floor(Number(route.flightCount) || 1));
    const existing = directionalRoutes.get(key);
    if (!existing || flightCount > existing.flightCount) {
      directionalRoutes.set(key, {
        origin: route.origin,
        destination: route.destination,
        flightCount,
      });
    }
  }

  const points = new Map<string, WeightedPoint>();
  for (const route of [...directionalRoutes.values()].sort((left, right) =>
    `${airportKey(left.origin)}>${airportKey(left.destination)}`.localeCompare(
      `${airportKey(right.origin)}>${airportKey(right.destination)}`,
    ),
  )) {
    const routeWeight = 1 + Math.min(6, Math.log2(route.flightCount));
    addPoint(points, route.origin, routeWeight);
    addPoint(points, route.destination, routeWeight);
  }

  return [...points.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function addPoint(
  points: Map<string, WeightedPoint>,
  airport: Airport,
  weight: number,
) {
  const key = airportKey(airport);
  const existing = points.get(key);
  if (existing) {
    existing.weight += weight;
    return;
  }
  points.set(key, {
    key,
    lat: clamp(airport.lat, -85, 85),
    lon: normalizeLongitude(airport.lon),
    weight,
  });
}

function frameSparseHistory(points: WeightedPoint[]): MapFrame {
  if (points.length === 1) return framePoints(points, "local", 1);
  const distanceKm = greatCircleKm(points[0], points[1]);
  const scope: MapFrameScope =
    distanceKm <= 500
      ? "local"
      : distanceKm <= 2_500
        ? "regional"
        : distanceKm <= 7_000
          ? "continental"
          : "global";
  return scope === "global"
    ? WORLD_MAP_FRAME
    : framePoints(points, scope, 1);
}

function framePoints(
  points: WeightedPoint[],
  scope: Exclude<MapFrameScope, "global">,
  confidence: number,
): MapFrame {
  const longitudeArc = minimalLongitudeArc(points.map(({ lon }) => lon));
  const latitudes = points.map(({ lat }) => lat);
  const rawSouth = Math.min(...latitudes);
  const rawNorth = Math.max(...latitudes);
  const minimumSpan =
    scope === "local"
      ? { lon: 3.5, lat: 2.5 }
      : scope === "regional"
        ? { lon: 14, lat: 10 }
        : { lon: 45, lat: 25 };
  const longitudeSpan = Math.max(minimumSpan.lon, longitudeArc.east - longitudeArc.west);
  const latitudeSpan = Math.max(minimumSpan.lat, rawNorth - rawSouth);
  const longitudePadding = Math.max(1.2, longitudeSpan * 0.16);
  const latitudePadding = Math.max(1, latitudeSpan * 0.16);
  const longitudeMidpoint = (longitudeArc.west + longitudeArc.east) / 2;
  const latitudeMidpoint = (rawSouth + rawNorth) / 2;
  const west = longitudeMidpoint - longitudeSpan / 2 - longitudePadding;
  const east = longitudeMidpoint + longitudeSpan / 2 + longitudePadding;
  const south = clamp(
    latitudeMidpoint - latitudeSpan / 2 - latitudePadding,
    -85,
    85,
  );
  const north = clamp(
    latitudeMidpoint + latitudeSpan / 2 + latitudePadding,
    -85,
    85,
  );
  const [minimumZoom, maximumZoom] = SCOPE_ZOOM_LIMITS[scope];
  const fittedZoom =
    Math.min(
      Math.log2(360 / Math.max(1, east - west)),
      Math.log2(170 / Math.max(1, north - south)),
    ) - 0.18;

  return {
    center: [
      round(normalizeLongitude((west + east) / 2)),
      round((south + north) / 2),
    ],
    zoom: round(clamp(fittedZoom, minimumZoom, maximumZoom)),
    bounds: [
      [round(west), round(south)],
      [round(east), round(north)],
    ],
    scope,
    confidence: round(confidence),
  };
}

function minimalLongitudeArc(longitudes: number[]) {
  if (longitudes.length === 1) {
    return { west: longitudes[0], east: longitudes[0] };
  }
  const sorted = longitudes
    .map((longitude) => ((longitude % 360) + 360) % 360)
    .sort((left, right) => left - right);
  let largestGap = -1;
  let gapIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const next =
      index === sorted.length - 1 ? sorted[0] + 360 : sorted[index + 1];
    const gap = next - sorted[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  let west = sorted[(gapIndex + 1) % sorted.length];
  let east = sorted[gapIndex];
  if (east < west) east += 360;
  if ((west + east) / 2 > 180) {
    west -= 360;
    east -= 360;
  }
  return { west, east };
}

function geographicDiameterKm(points: WeightedPoint[]): number {
  let diameter = 0;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      diameter = Math.max(diameter, greatCircleKm(points[left], points[right]));
    }
  }
  return diameter;
}

function greatCircleKm(
  left: Pick<WeightedPoint, "lat" | "lon">,
  right: Pick<WeightedPoint, "lat" | "lon">,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.lat - left.lat);
  const longitudeDelta = radians(right.lon - left.lon);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.lat)) *
      Math.cos(radians(right.lat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function mapSafeAirport(airport: Airport): boolean {
  return (
    Number.isFinite(airport.lat) &&
    Number.isFinite(airport.lon) &&
    airport.lat >= -90 &&
    airport.lat <= 90
  );
}

function airportKey(airport: Airport): string {
  const code = airport.code.trim().toUpperCase();
  return code || `${round(airport.lat, 4)},${round(airport.lon, 4)}`;
}

function normalizeLongitude(longitude: number): number {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, precision = 6): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}
