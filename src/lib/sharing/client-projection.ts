import type { PublicMapProjection } from "@/lib/sharing/service";

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;

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
      ? ["owner", "summary", "routes", "flights"]
      : ["owner", "summary", "routes"],
  );
  const hasFlightDimensions =
    hasFlightsKey && projection.flights !== null;
  const owner = exactRecord(projection.owner, ["displayName"]);
  const summary = exactRecord(projection.summary, [
    "flightCount",
    "routeCount",
  ]);
  if (
    !isDisplayName(owner.displayName) ||
    !isNonNegativeInteger(summary.flightCount) ||
    !isNonNegativeInteger(summary.routeCount) ||
    !Array.isArray(projection.routes)
  ) {
    throw new PublicMapProjectionValidationError();
  }

  const routes = projection.routes.map(parsePublicRoute);
  const flights = hasFlightDimensions
    ? parsePublicFlights(projection.flights)
    : null;
  const routeIds = new Set(routes.map(({ id }) => id));
  const routeKindById = new Map(
    routes.map(({ id, kind }) => [id, kind] as const),
  );
  const representedLegs = routes.reduce(
    (total, route) => total + route.flightCount,
    0,
  );
  const referencedLegs =
    flights?.reduce(
      (total, flight) => total + flight.routeIds.length,
      0,
    ) ?? null;
  const referencesByRouteId = new Map<string, number>();
  for (const flight of flights ?? []) {
    for (const routeId of flight.routeIds) {
      referencesByRouteId.set(
        routeId,
        (referencesByRouteId.get(routeId) ?? 0) + 1,
      );
    }
  }
  if (
    summary.routeCount !== routes.length ||
    routeIds.size !== routes.length ||
    (summary.flightCount === 0) !== (routes.length === 0) ||
    !Number.isSafeInteger(representedLegs) ||
    summary.flightCount > representedLegs ||
    (flights !== null &&
      (flights.length !== summary.flightCount ||
        referencedLegs !== representedLegs ||
        routes.some(
          (route) =>
            (referencesByRouteId.get(route.id) ?? 0) !== route.flightCount,
        ) ||
        flights.some(
          (flight) =>
            flight.routeIds.length === 0 ||
            flight.routeIds.some(
              (routeId) => routeKindById.get(routeId) !== flight.kind,
            ),
        )))
  ) {
    throw new PublicMapProjectionValidationError();
  }

  return {
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
      "routeIds",
    ]);
    if (
      typeof flight.date !== "string" ||
      !isPublicDate(flight.date) ||
      (flight.kind !== "commercial" && flight.kind !== "private") ||
      (flight.role !== "passenger" && flight.role !== "pilot") ||
      !Array.isArray(flight.aircraft) ||
      flight.aircraft.length > 8 ||
      flight.aircraft.some((value) => !isPublicMetadata(value)) ||
      (flight.registration !== null &&
        !isPublicMetadata(flight.registration)) ||
      !Array.isArray(flight.routeIds) ||
      flight.routeIds.some(
        (routeId) =>
          typeof routeId !== "string" || !ROUTE_ID_PATTERN.test(routeId),
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
      routeIds: [...flight.routeIds],
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
    "origin",
    "destination",
  ]);
  if (
    typeof route.id !== "string" ||
    !ROUTE_ID_PATTERN.test(route.id) ||
    (route.kind !== "commercial" && route.kind !== "private") ||
    !isPositiveInteger(route.flightCount)
  ) {
    throw new PublicMapProjectionValidationError();
  }
  return {
    id: route.id,
    kind: route.kind,
    flightCount: route.flightCount,
    origin: parseCoarsePlace(route.origin),
    destination: parseCoarsePlace(route.destination),
  };
}

function parseCoarsePlace(
  value: unknown,
): PublicMapProjection["routes"][number]["origin"] {
  const place = exactRecord(value, ["lat", "lon", "country"]);
  if (
    !isCoarseCoordinate(place.lat, -90, 90) ||
    !isCoarseCoordinate(place.lon, -180, 180) ||
    typeof place.country !== "string" ||
    place.country !== place.country.trim() ||
    !COUNTRY_PATTERN.test(place.country)
  ) {
    throw new PublicMapProjectionValidationError();
  }
  return {
    lat: normalizeZero(place.lat),
    lon: normalizeZero(place.lon),
    country: place.country,
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

function isCoarseCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    value === Math.round(value * 10) / 10
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
