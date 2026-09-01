import {
  deriveRouteDirectionMode,
  type Airport,
  type MapRoute,
  type RouteDirectionMode,
} from "./flight-data";
import { airportIdentity } from "./route-aggregation";

export type { RouteDirectionMode } from "./flight-data";

export type RouteDirection = {
  mode: RouteDirectionMode;
  cue: "➤" | "↔" | "";
  origin: Airport;
  destination: Airport;
  forwardFlightCount: number;
  reverseFlightCount: number;
};

export function routeDirection(route: MapRoute): RouteDirection {
  const sameAirport =
    airportIdentity(route.origin) === airportIdentity(route.destination);
  const hasDirectionalCounts =
    route.forwardFlightCount !== undefined ||
    route.reverseFlightCount !== undefined;
  const forwardFlightCount = nonNegativeCount(route.forwardFlightCount);
  const reverseFlightCount = nonNegativeCount(route.reverseFlightCount);

  if (sameAirport) {
    return {
      mode: "none",
      cue: "",
      origin: route.origin,
      destination: route.destination,
      forwardFlightCount,
      reverseFlightCount,
    };
  }
  if (!hasDirectionalCounts) {
    return {
      mode: "one-way",
      cue: "➤",
      origin: route.origin,
      destination: route.destination,
      forwardFlightCount: nonNegativeCount(route.flightCount),
      reverseFlightCount: 0,
    };
  }
  const mode = deriveRouteDirectionMode(
    forwardFlightCount,
    reverseFlightCount,
    sameAirport,
  );
  if (mode === "both") {
    return {
      mode,
      cue: "↔",
      origin: route.origin,
      destination: route.destination,
      forwardFlightCount,
      reverseFlightCount,
    };
  }
  if (forwardFlightCount > 0) {
    return {
      mode: "one-way",
      cue: "➤",
      origin: route.origin,
      destination: route.destination,
      forwardFlightCount,
      reverseFlightCount,
    };
  }
  if (reverseFlightCount > 0) {
    return {
      mode: "one-way",
      cue: "➤",
      origin: route.destination,
      destination: route.origin,
      forwardFlightCount,
      reverseFlightCount,
    };
  }
  return {
    mode: "none",
    cue: "",
    origin: route.origin,
    destination: route.destination,
    forwardFlightCount,
    reverseFlightCount,
  };
}

export function formatRouteDirection(
  route: MapRoute,
  formatAirport: (airport: Airport) => string = ({ code }) => code,
): string {
  const direction = routeDirection(route);
  const separator = direction.cue || "—";
  return `${formatAirport(direction.origin)} ${separator} ${formatAirport(direction.destination)}`;
}

/**
 * Map-safe variants of the route title/detail strings. Anything rendered
 * through MapLibre's glyph pipeline must stay inside the character coverage
 * the basemap's font stack actually ships: the default OpenFreeMap Noto Sans
 * glyph ranges do not include U+27A4 (➤) or U+2194 (↔), so those characters
 * silently fall back to an unrelated substitute shape on the map canvas.
 * Direction on the map is carried exclusively by the raster geometry icons;
 * these strings pair airport codes with a plain ASCII separator and never
 * embed a direction cue character. The arrow-bearing strings remain for DOM
 * popups, the legend and stats titles, which render with real web fonts.
 */
export const MAP_SAFE_ROUTE_SEPARATOR = "-";

export function formatRouteDirectionMapSafe(
  route: MapRoute,
  formatAirport: (airport: Airport) => string = ({ code }) => code,
): string {
  const direction = routeDirection(route);
  return `${formatAirport(direction.origin)}${MAP_SAFE_ROUTE_SEPARATOR}${formatAirport(direction.destination)}`;
}

export function routeDirectionDetailMapSafe(route: MapRoute): string {
  const direction = routeDirection(route);
  if (direction.mode === "none") return "Direction unavailable";
  const forwardLeg = `${route.origin.code}${MAP_SAFE_ROUTE_SEPARATOR}${route.destination.code}`;
  const reverseLeg = `${route.destination.code}${MAP_SAFE_ROUTE_SEPARATOR}${route.origin.code}`;
  if (direction.mode === "one-way") {
    return `${route.flightCount.toLocaleString()} ${formatRouteDirectionMapSafe(route)}`;
  }
  return `${direction.forwardFlightCount.toLocaleString()} ${forwardLeg} · ${direction.reverseFlightCount.toLocaleString()} ${reverseLeg}`;
}

export function routeDirectionDetail(route: MapRoute): string {
  const direction = routeDirection(route);
  if (direction.mode === "none") return "Direction unavailable";
  if (direction.mode === "one-way") {
    return `${route.flightCount.toLocaleString()} ${direction.origin.code} ➤ ${direction.destination.code}`;
  }
  return `${direction.forwardFlightCount.toLocaleString()} ${route.origin.code} ➤ ${route.destination.code} · ${direction.reverseFlightCount.toLocaleString()} ${route.destination.code} ➤ ${route.origin.code}`;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0;
}
