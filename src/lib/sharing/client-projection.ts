import type { PublicMapProjection } from "@/lib/sharing/service";
import {
  airportExactIdentity,
  deriveRouteDirectionMode,
} from "@/lib/flight-data";
import { isPublicAirportCode } from "@/lib/airport-preferred-code";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "@/lib/flight-metadata";

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;
const LEGACY_APPROXIMATE_REGION_PATTERN = /^approximate region(?:\s+in)?(?:\s|$)/i;

export class PublicMapProjectionValidationError extends Error {
  constructor() {
    super("Invalid public map projection.");
    this.name = "PublicMapProjectionValidationError";
  }
}

export function parsePublicMapProjection(
  value: unknown,
): PublicMapProjection {
  if (!isRecord(value)) throw new PublicMapProjectionValidationError();
  const hasFlightsKey = Object.hasOwn(value, "flights");
  const projection = exactRecord(
    value,
    hasFlightsKey
      ? ["schemaVersion", "owner", "summary", "routes", "flights"]
      : ["schemaVersion", "owner", "summary", "routes"],
  );
  const owner = exactRecord(projection.owner, ["displayName"]);
  const summary = exactRecord(projection.summary, [
    "flightCount",
    "routeCount",
  ]);
  if (
    projection.schemaVersion !== 3 ||
    !isDisplayName(owner.displayName) ||
    !isNonNegativeInteger(summary.flightCount) ||
    !isNonNegativeInteger(summary.routeCount) ||
    !Array.isArray(projection.routes)
  ) {
    throw new PublicMapProjectionValidationError();
  }

  const routes = projection.routes.map(parsePublicRoute);
  if (!hasFlightsKey) throw new PublicMapProjectionValidationError();
  const flights = parsePublicFlights(projection.flights);
  const routeIds = new Set(routes.map(({ id }) => id));
  const routeKindById = new Map(
    routes.map(({ id, kind }) => [id, kind] as const),
  );
  const routeModeById = new Map(
    routes.map(({ id, directionMode }) => [id, directionMode] as const),
  );
  const representedLegs = routes.reduce(
    (total, route) => total + route.flightCount,
    0,
  );
  const referencedLegs = flights.reduce(
    (total, flight) => total + flight.routeLegs.length,
    0,
  );
  const referencesByRouteId = new Map<string, number>();
  const forwardReferencesByRouteId = new Map<string, number>();
  const reverseReferencesByRouteId = new Map<string, number>();
  for (const flight of flights) {
    for (const { routeId, direction } of flight.routeLegs) {
      referencesByRouteId.set(
        routeId,
        (referencesByRouteId.get(routeId) ?? 0) + 1,
      );
      if (direction === "forward") {
        forwardReferencesByRouteId.set(
          routeId,
          (forwardReferencesByRouteId.get(routeId) ?? 0) + 1,
        );
      }
      if (direction === "reverse") {
        reverseReferencesByRouteId.set(
          routeId,
          (reverseReferencesByRouteId.get(routeId) ?? 0) + 1,
        );
      }
    }
  }
  if (
    summary.routeCount !== routes.length ||
    routeIds.size !== routes.length ||
    (summary.flightCount === 0) !== (routes.length === 0) ||
    !Number.isSafeInteger(representedLegs) ||
    summary.flightCount > representedLegs ||
    (flights.length !== summary.flightCount ||
      referencedLegs !== representedLegs ||
      routes.some(
        (route) =>
          (referencesByRouteId.get(route.id) ?? 0) !== route.flightCount,
      ) ||
      routes.some(
        (route) =>
          (forwardReferencesByRouteId.get(route.id) ?? 0) !==
            route.forwardFlightCount ||
          (reverseReferencesByRouteId.get(route.id) ?? 0) !==
            route.reverseFlightCount,
      ) ||
      flights.some(
        (flight) =>
          flight.routeLegs.length === 0 ||
          new Set(flight.routeLegs.map(({ routeId }) => routeId)).size !==
            flight.routeLegs.length ||
          flight.routeLegs.some(
            ({ routeId, direction }) =>
              routeKindById.get(routeId) !== flight.kind ||
              (routeModeById.get(routeId) === "none") !==
                (direction === "none"),
          ),
      ))
  ) {
    throw new PublicMapProjectionValidationError();
  }

  return {
    schemaVersion: 3,
    owner: { displayName: owner.displayName },
    summary: {
      flightCount: summary.flightCount,
      routeCount: summary.routeCount,
    },
    routes,
    flights,
  };
}

function parsePublicFlights(
  value: unknown,
): NonNullable<PublicMapProjection["flights"]> {
  if (!Array.isArray(value)) {
    throw new PublicMapProjectionValidationError();
  }
  return value.map((entry) => {
    const flight = exactRecord(entry, [
      "date",
      "kind",
      "role",
      "aircraft",
      "registration",
      "routeLegs",
    ]);
    if (
      typeof flight.date !== "string" ||
      !isPublicDate(flight.date) ||
      (flight.kind !== "commercial" && flight.kind !== "private") ||
      (flight.role !== "passenger" && flight.role !== "pilot") ||
      !Array.isArray(flight.aircraft) ||
      flight.aircraft.length > 8 ||
      flight.aircraft.some(
        (value) =>
          typeof value !== "string" ||
          normalizeAircraftMetadata(value) !== value,
      ) ||
      (flight.registration !== null &&
        (typeof flight.registration !== "string" ||
          normalizeRegistrationMetadata(flight.registration) !==
            flight.registration)) ||
      !Array.isArray(flight.routeLegs) ||
      flight.routeLegs.some(
        (leg) =>
          !isRecord(leg) ||
          Reflect.ownKeys(leg).length !== 2 ||
          typeof leg.routeId !== "string" ||
          !ROUTE_ID_PATTERN.test(leg.routeId) ||
          (leg.direction !== "forward" &&
            leg.direction !== "reverse" &&
            leg.direction !== "none"),
      )
    ) {
      throw new PublicMapProjectionValidationError();
    }
    return {
      date: flight.date,
      kind: flight.kind,
      role: flight.role,
      aircraft: [...flight.aircraft],
      registration: flight.registration,
      routeLegs: flight.routeLegs.map(({ routeId, direction }) => ({
        routeId,
        direction,
      })),
    };
  });
}

function parsePublicRoute(
  value: unknown,
): PublicMapProjection["routes"][number] {
  const route = exactRecord(value, [
    "id",
    "kind",
    "flightCount",
    "forwardFlightCount",
    "reverseFlightCount",
    "directionMode",
    "origin",
    "destination",
  ]);
  if (
    typeof route.id !== "string" ||
    !ROUTE_ID_PATTERN.test(route.id) ||
    (route.kind !== "commercial" && route.kind !== "private") ||
    !isPositiveInteger(route.flightCount) ||
    !isNonNegativeInteger(route.forwardFlightCount) ||
    !isNonNegativeInteger(route.reverseFlightCount)
  ) {
    throw new PublicMapProjectionValidationError();
  }
  const origin = parsePublicAirport(route.origin);
  const destination = parsePublicAirport(route.destination);
  const directionMode = route.directionMode;
  const sameAirport =
    publicAirportIdentity(origin) === publicAirportIdentity(destination);
  if (
    (directionMode !== "one-way" &&
      directionMode !== "both" &&
      directionMode !== "none") ||
    directionMode !==
      deriveRouteDirectionMode(
        route.forwardFlightCount,
        route.reverseFlightCount,
        sameAirport,
      ) ||
    (sameAirport
      ? route.forwardFlightCount !== 0 || route.reverseFlightCount !== 0
      : route.forwardFlightCount + route.reverseFlightCount !==
        route.flightCount)
  ) {
    throw new PublicMapProjectionValidationError();
  }
  return {
    id: route.id,
    kind: route.kind,
    flightCount: route.flightCount,
    forwardFlightCount: route.forwardFlightCount,
    reverseFlightCount: route.reverseFlightCount,
    directionMode,
    origin,
    destination,
  };
}

function publicAirportIdentity(
  airport: PublicMapProjection["routes"][number]["origin"],
): string {
  return airportExactIdentity(airport);
}

function parsePublicAirport(
  value: unknown,
): PublicMapProjection["routes"][number]["origin"] {
  const place = exactRecord(value, [
    "code",
    "name",
    "city",
    "country",
    "lat",
    "lon",
    "facility",
  ]);
  if (
    typeof place.code !== "string" ||
    place.code !== place.code.trim() ||
    !isPublicAirportCode(place.code) ||
    !isPublicMetadata(place.name) ||
    !isPublicMetadata(place.city) ||
    LEGACY_APPROXIMATE_REGION_PATTERN.test(place.name) ||
    LEGACY_APPROXIMATE_REGION_PATTERN.test(place.city) ||
    typeof place.country !== "string" ||
    place.country !== place.country.trim() ||
    !COUNTRY_PATTERN.test(place.country) ||
    !isCoordinate(place.lat, -90, 90) ||
    !isCoordinate(place.lon, -180, 180) ||
    (place.facility !== "commercial" &&
      place.facility !== "general-aviation" &&
      place.facility !== "airstrip")
  ) {
    throw new PublicMapProjectionValidationError();
  }
  return {
    code: place.code,
    name: place.name,
    city: place.city,
    country: place.country,
    lat: normalizeZero(place.lat),
    lon: normalizeZero(place.lon),
    facility: place.facility,
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new PublicMapProjectionValidationError();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new PublicMapProjectionValidationError();
  }
  return value;
}

function isDisplayName(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value === value.trim() &&
      value.length >= 1 &&
      value.length <= 100)
  );
}

function isPublicMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isPublicDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function isCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
