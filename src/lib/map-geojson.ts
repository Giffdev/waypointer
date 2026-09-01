import type { Airport, MapRoute } from "./flight-data";
import { routeFrequencyStrength } from "./map-visualization";
import { airportIdentity } from "./route-aggregation";
import {
  formatRouteDirection,
  formatRouteDirectionMapSafe,
  routeDirection,
  routeDirectionDetail,
  routeDirectionDetailMapSafe,
  type RouteDirectionMode,
} from "./route-direction";

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
      directionMode: RouteDirectionMode;
      directionCue: "➤" | "↔" | "";
      directionDetail: string;
      routeTitle: string;
      strength: number;
      originIdentity: string;
      originCode: string;
      originName: string;
      destinationIdentity: string;
      destinationCode: string;
      destinationName: string;
      /**
       * DOM-facing label: keeps the Unicode direction cue, for popups,
       * assistive text and any HTML surface rendered with a web font.
       */
      routeLabel: string;
      /**
       * Map-facing label: rendered through MapLibre's glyph pipeline, so it
       * must never contain a direction cue character the basemap font stack
       * may not ship a glyph for. Direction on the map is carried by the
       * raster geometry icons instead.
       */
      mapSafeRouteLabel: string;
      laneOffset: number;
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
      identity: string;
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

  return {
    type: "FeatureCollection",
    features: routes.map((route) => {
      const direction = routeDirection(route);
      const routeTitle = formatRouteDirection(route);
      const directionDetail = routeDirectionDetail(route);
      const directionSummary =
        direction.mode === "both" ? ` (${directionDetail})` : "";
      const flightCountLabel = `${route.flightCount} ${route.flightCount === 1 ? "flight" : "flights"}`;
      const mapSafeDirectionSummary =
        direction.mode === "both"
          ? ` (${routeDirectionDetailMapSafe(route)})`
          : "";
      return {
        type: "Feature",
        properties: {
          id: route.id,
          kind: route.kind,
          flightCount: route.flightCount,
          forwardFlightCount: direction.forwardFlightCount,
          reverseFlightCount: direction.reverseFlightCount,
          bidirectional: direction.mode === "both",
          directionMode: direction.mode,
          directionCue: direction.cue,
          directionDetail,
          routeTitle,
          strength: routeFrequencyStrength(route.flightCount, maximumRouteCount),
          originIdentity: airportIdentity(route.origin),
          originCode: route.origin.code,
          originName: route.origin.name,
          destinationIdentity: airportIdentity(route.destination),
          destinationCode: route.destination.code,
          destinationName: route.destination.name,
          routeLabel: `${routeTitle} · ${flightCountLabel}${directionSummary}`,
          mapSafeRouteLabel: `${formatRouteDirectionMapSafe(route)} · ${flightCountLabel}${mapSafeDirectionSummary}`,
          laneOffset: 0,
        },
        geometry: {
          type: "MultiLineString",
          coordinates: splitAtAntimeridian(
            greatCircleCoordinates(
              direction.origin,
              direction.destination,
              pointCount,
            ),
          ),
        },
      };
    }),
  };
}

export function createAirportFeatureCollection(
  airports: Airport[],
  routes: MapRoute[],
): AirportFeatureCollection {
  const traffic = new Map<string, number>();
  for (const route of routes) {
    const originIdentity = airportIdentity(route.origin);
    const destinationIdentity = airportIdentity(route.destination);
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
      airportIdentity(route.origin),
      airportIdentity(route.destination),
    ]),
  );

  return {
    type: "FeatureCollection",
    features: airports.map((airport) => ({
      type: "Feature",
      properties: {
        identity: airportIdentity(airport),
        code: airport.code,
        name: airport.name,
        city: airport.city,
        facility: airport.facility,
        traffic: traffic.get(airportIdentity(airport)) ?? 0,
        isHub: hubs.has(airportIdentity(airport)),
        isActive: activeAirports.has(airportIdentity(airport)),
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
