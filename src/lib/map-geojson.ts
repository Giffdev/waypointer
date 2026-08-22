import type { Airport, MapRoute } from "./flight-data";
import { routeFrequencyStrength } from "./map-visualization";
import { airportGeometryIdentity } from "./route-aggregation";

type Position = [number, number];

export type RouteFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      id: string;
      kind: MapRoute["kind"];
      flightCount: number;
      forwardFlightCount: number;
      reverseFlightCount: number;
      bidirectional: boolean;
      strength: number;
      originCode: string;
      originName: string;
      destinationCode: string;
      destinationName: string;
      routeLabel: string;
      laneOffset: number;
      showDirection: boolean;
    };
    geometry: {
      type: "MultiLineString";
      coordinates: Position[][];
    };
  }>;
};

export type AirportFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      code: string;
      name: string;
      city: string;
      facility: Airport["facility"];
      traffic: number;
      isHub: boolean;
      isActive: boolean;
    };
    geometry: {
      type: "Point";
      coordinates: Position;
    };
  }>;
};

export function createRouteFeatureCollection(routes: MapRoute[]): RouteFeatureCollection {
  const maximumRouteCount = Math.max(1, ...routes.map((route) => route.flightCount));
  const pointCount = routes.length >= 150 ? 28 : routes.length >= 60 ? 36 : 48;
  const directionVisibility = routeDirectionVisibility(routes);

  return {
    type: "FeatureCollection",
    features: routes.map((route) => {
      const forwardFlightCount =
        route.forwardFlightCount ?? route.flightCount;
      const reverseFlightCount = route.reverseFlightCount ?? 0;
      const reverseGeometry =
        forwardFlightCount === 0 && reverseFlightCount > 0;
      const geometryOrigin = reverseGeometry ? route.destination : route.origin;
      const geometryDestination = reverseGeometry
        ? route.origin
        : route.destination;
      const bidirectional =
        forwardFlightCount > 0 && reverseFlightCount > 0;
      const directionSummary = bidirectional
        ? ` (${route.origin.code} → ${route.destination.code} ${forwardFlightCount} · ${route.destination.code} → ${route.origin.code} ${reverseFlightCount})`
        : "";
      return {
        type: "Feature",
        properties: {
          id: route.id,
          kind: route.kind,
          flightCount: route.flightCount,
          forwardFlightCount,
          reverseFlightCount,
          bidirectional,
          strength: routeFrequencyStrength(route.flightCount, maximumRouteCount),
          originCode: route.origin.code,
          originName: route.origin.name,
          destinationCode: route.destination.code,
          destinationName: route.destination.name,
          routeLabel: `${reverseGeometry ? route.destination.code : route.origin.code}${bidirectional ? " ↔ " : " → "}${reverseGeometry ? route.origin.code : route.destination.code} · ${route.flightCount} ${route.flightCount === 1 ? "flight" : "flights"}${directionSummary}`,
          laneOffset: 0,
          showDirection: directionVisibility.get(route.id) ?? false,
        },
        geometry: {
          type: "MultiLineString",
          coordinates: splitAtAntimeridian(
            greatCircleCoordinates(geometryOrigin, geometryDestination, pointCount),
          ),
        },
      };
    }),
  };
}

export function routeDirectionVisibility(routes: MapRoute[]): Map<string, boolean> {
  const groups = new Map<string, MapRoute[]>();
  for (const route of routes) {
    const endpoints = [
      airportGeometryIdentity(route.origin),
      airportGeometryIdentity(route.destination),
    ].sort();
    const key = `${route.kind}:${endpoints[0]}:${endpoints[1]}`;
    const group = groups.get(key) ?? [];
    group.push(route);
    groups.set(key, group);
  }

  const visibility = new Map<string, boolean>();
  for (const group of groups.values()) {
    const bidirectional = new Set(
      group.map(
        ({ origin, destination }) =>
          `${airportGeometryIdentity(origin)}:${airportGeometryIdentity(destination)}`,
      ),
    ).size > 1;
    for (const route of group) {
      const hasDirectionCounts =
        route.forwardFlightCount !== undefined ||
        route.reverseFlightCount !== undefined;
      const routeBidirectional = hasDirectionCounts
        ? (route.forwardFlightCount ?? 0) > 0 &&
          (route.reverseFlightCount ?? 0) > 0
        : bidirectional;
      visibility.set(
        route.id,
        !routeBidirectional &&
          airportGeometryIdentity(route.origin) !==
            airportGeometryIdentity(route.destination) &&
          route.flightCount <= 3,
      );
    }
  }
  return visibility;
}

export function createAirportFeatureCollection(
  airports: Airport[],
  routes: MapRoute[],
): AirportFeatureCollection {
  const traffic = new Map<string, number>();
  for (const route of routes) {
    const originIdentity = airportGeometryIdentity(route.origin);
    const destinationIdentity = airportGeometryIdentity(route.destination);
    traffic.set(
      originIdentity,
      (traffic.get(originIdentity) ?? 0) + route.flightCount,
    );
    traffic.set(
      destinationIdentity,
      (traffic.get(destinationIdentity) ?? 0) + route.flightCount,
    );
  }
  const hubs = new Set(
    [...traffic.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([identity]) => identity),
  );
  const activeAirports = new Set(
    routes.flatMap((route) => [
      airportGeometryIdentity(route.origin),
      airportGeometryIdentity(route.destination),
    ]),
  );

  return {
    type: "FeatureCollection",
    features: airports.map((airport) => ({
      type: "Feature",
      properties: {
        code: airport.code,
        name: airport.name,
        city: airport.city,
        facility: airport.facility,
        traffic: traffic.get(airportGeometryIdentity(airport)) ?? 0,
        isHub: hubs.has(airportGeometryIdentity(airport)),
        isActive: activeAirports.has(airportGeometryIdentity(airport)),
      },
      geometry: {
        type: "Point",
        coordinates: [airport.lon, airport.lat],
      },
    })),
  };
}

function greatCircleCoordinates(
  origin: Pick<Airport, "lat" | "lon">,
  destination: Pick<Airport, "lat" | "lon">,
  pointCount: number,
): Position[] {
  const start = toUnitVector(origin);
  const end = toUnitVector(destination);
  const dot = Math.min(1, Math.max(-1, start.x * end.x + start.y * end.y + start.z * end.z));
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);

  return Array.from({ length: pointCount }, (_, index) => {
    const progress = index / (pointCount - 1);
    if (sine < 0.000001) {
      return [
        origin.lon + (destination.lon - origin.lon) * progress,
        origin.lat + (destination.lat - origin.lat) * progress,
      ];
    }
    const startWeight = Math.sin((1 - progress) * angle) / sine;
    const endWeight = Math.sin(progress * angle) / sine;
    const x = start.x * startWeight + end.x * endWeight;
    const y = start.y * startWeight + end.y * endWeight;
    const z = start.z * startWeight + end.z * endWeight;
    return [normalizeLongitude((Math.atan2(y, x) * 180) / Math.PI), (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI];
  });
}

function splitAtAntimeridian(coordinates: Position[]): Position[][] {
  const lines: Position[][] = [[coordinates[0]]];

  for (const next of coordinates.slice(1)) {
    const line = lines[lines.length - 1];
    const previous = line[line.length - 1];
    const delta = next[0] - previous[0];
    if (Math.abs(delta) <= 180) {
      line.push(next);
      continue;
    }

    const adjustedLongitude = next[0] + (delta > 180 ? -360 : 360);
    const boundary = delta > 180 ? -180 : 180;
    const progress = (boundary - previous[0]) / (adjustedLongitude - previous[0]);
    const latitude = previous[1] + (next[1] - previous[1]) * progress;
    line.push([boundary, latitude]);
    lines.push([[boundary === 180 ? -180 : 180, latitude], next]);
  }

  return lines;
}

function toUnitVector(location: Pick<Airport, "lat" | "lon">) {
  const latitude = (location.lat * Math.PI) / 180;
  const longitude = (location.lon * Math.PI) / 180;
  return {
    x: Math.cos(latitude) * Math.cos(longitude),
    y: Math.cos(latitude) * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}
