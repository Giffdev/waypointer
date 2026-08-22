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
