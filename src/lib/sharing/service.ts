import { createHash } from "node:crypto";
import { asc, count, eq, sql } from "drizzle-orm";
import { getDb, withUserDb, type DatabaseTransaction } from "@/lib/db";
import {
  airports,
  flightStops,
  flights,
  mapShareFlights,
  mapShares,
  users,
} from "@/lib/db/schema";
import { isValidPublicHandle, normalizeUsername } from "@/lib/auth/username";
import type { Airport } from "@/lib/flight-data";
import {
  isPublicAirportCode,
  preferredAirportCode,
} from "@/lib/airport-preferred-code";
import {
  parsePublicMapProjection,
  PublicMapProjectionValidationError,
} from "./client-projection";

const PUBLIC_ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PUBLIC_COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;
const PUBLIC_MAP_PROJECTION_SCHEMA_VERSION = 2;

type PublicAirport = Pick<
  Airport,
  "code" | "name" | "city" | "country" | "lat" | "lon" | "facility"
>;

export type OwnerShareStatus = {
  enabled: boolean;
  publicHandle: string | null;
  sharePath: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  publishedFlightCount: number;
};

export type PublicMapProjection = {
  schemaVersion: typeof PUBLIC_MAP_PROJECTION_SCHEMA_VERSION;
  owner: { displayName: string | null };
  summary: { flightCount: number; routeCount: number };
  routes: Array<{
    id: string;
    kind: "commercial" | "private";
    flightCount: number;
    origin: PublicAirport;
    destination: PublicAirport;
  }>;
  flights: Array<{
    date: string;
    kind: "commercial" | "private";
    role: "passenger" | "pilot";
    aircraft: string[];
    registration: string | null;
    routeIds: string[];
  }>;
};

export class ShareNotFoundError extends Error {}
export class ShareValidationError extends Error {
  constructor(readonly code = "invalid-share-projection") {
    super("Invalid share projection.");
    this.name = "ShareValidationError";
  }
}
export class ShareEmptyMapError extends Error {}
export class ShareRepublishRequiredError extends Error {}

export function formatHandleSharePath(handle: string): string {
  return `/${handle}`;
}

export async function getOwnerShareStatus(
  userId: string,
): Promise<OwnerShareStatus> {
  return withUserDb(userId, async (tx) => {
    const [share] = await tx
      .select()
      .from(mapShares)
      .where(eq(mapShares.userId, userId))
      .limit(1);
    const [owner] = await tx
      .select({
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!owner) throw new Error("Authentication is required.");
    const publicHandle = owner.username;
    const [selected] = await tx
      .select({ flightCount: count() })
      .from(mapShareFlights)
      .where(eq(mapShareFlights.userId, userId));
    if (!share) {
      return {
        enabled: false,
        publicHandle,
        sharePath: null,
        enabledAt: null,
        disabledAt: null,
        publishedFlightCount: 0,
      };
    }
    const enabled = Boolean(share.enabledAt && !share.disabledAt);
    return {
      enabled,
      publicHandle,
      sharePath: enabled ? formatHandleSharePath(publicHandle) : null,
      enabledAt: share.enabledAt?.toISOString() ?? null,
      disabledAt: share.disabledAt?.toISOString() ?? null,
      publishedFlightCount: selected?.flightCount ?? 0,
    };
  });
}

export async function enableMapSharing(
  userId: string,
): Promise<OwnerShareStatus> {
  await withUserDb(userId, async (tx) => {
    await lockOwnerShare(tx, userId);
    const [owner] = await tx
      .select({
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!owner) throw new Error("Authentication is required.");
    const snapshot = await createSnapshot(tx, userId);
    const now = new Date();
    await tx
      .insert(mapShares)
      .values({
        userId,
        projection: snapshot.projection,
        enabledAt: now,
        disabledAt: null,
      })
      .onConflictDoUpdate({
        target: mapShares.userId,
        set: {
          projection: snapshot.projection,
          enabledAt: now,
          disabledAt: null,
          updatedAt: now,
        },
      });
    await tx
      .delete(mapShareFlights)
      .where(eq(mapShareFlights.userId, userId));
    const inserted = await tx.execute<{ flightCount: number }>(sql`
      with inserted as (
        insert into "map_share_flights" (
          "user_id",
          "flight_id",
          "selected_at"
        )
        select
          ${flights.userId},
          ${flights.id},
          current_timestamp
        from ${flights}
        where ${flights.userId} = ${userId}::uuid
        returning 1
      )
      select count(*)::integer as "flightCount" from inserted
    `);
    if (inserted[0]?.flightCount !== snapshot.flightIds.length) {
      throw new ShareValidationError("membership-count-mismatch");
    }
  });
  return getOwnerShareStatus(userId);
}

export async function disableMapSharing(
  userId: string,
): Promise<OwnerShareStatus> {
  await withUserDb(userId, async (tx) => {
    await lockOwnerShare(tx, userId);
    const now = new Date();
    await tx
      .update(mapShares)
      .set({
        disabledAt: now,
        updatedAt: now,
      })
      .where(eq(mapShares.userId, userId));
  });
  return getOwnerShareStatus(userId);
}

export async function getPublicMapProjection(
  identifier: string,
): Promise<PublicMapProjection> {
  const handle = normalizeUsername(identifier);
  if (!handle || !isValidPublicHandle(handle)) {
    throw new ShareNotFoundError();
  }
  const result = await getDb().execute<{
    projection: unknown;
  }>(sql`select public_map_projection_by_handle(${handle}) as projection`);
  const projection = result[0]?.projection;
  if (!projection) throw new ShareNotFoundError();
  if (
    !projection ||
    typeof projection !== "object" ||
    Reflect.get(projection, "schemaVersion") !==
      PUBLIC_MAP_PROJECTION_SCHEMA_VERSION
  ) {
    throw new ShareRepublishRequiredError();
  }
  const publicRoutes = sanitizeStoredPublicRoutes(
    Reflect.get(projection, "routes"),
  );
  const publicFlights = sanitizeStoredPublicFlights(
    Reflect.get(projection, "flights"),
    new Map(
      publicRoutes.map(({ id, kind, flightCount }) => [
        id,
        { kind, flightCount },
      ]),
    ),
  );
  const owner = Reflect.get(projection, "owner");
  const summary = Reflect.get(projection, "summary");
  return validatePublicMapProjection({
    schemaVersion: PUBLIC_MAP_PROJECTION_SCHEMA_VERSION,
    owner: {
      displayName:
        owner && typeof owner === "object"
          ? Reflect.get(owner, "displayName")
          : undefined,
    },
    summary: {
      flightCount:
        summary && typeof summary === "object"
          ? Reflect.get(summary, "flightCount")
          : undefined,
      routeCount:
        summary && typeof summary === "object"
          ? Reflect.get(summary, "routeCount")
          : undefined,
    },
    routes: publicRoutes,
    flights: publicFlights,
  });
}

export function publicHandleRateLimitKey(identifier: string): string {
  return normalizeUsername(identifier);
}

async function createSnapshot(
  tx: DatabaseTransaction,
  userId: string,
): Promise<{ projection: PublicMapProjection; flightIds: string[] }> {
  const selectedFlights = await tx
    .select({
      id: flights.id,
      date: flights.date,
      kind: flights.kind,
      role: flights.role,
      aircraft: flights.aircraft,
      aircraftType: flights.aircraftType,
      registration: flights.registration,
      originAirportId: flights.originAirportId,
      destinationAirportId: flights.destinationAirportId,
    })
    .from(flights)
    .where(eq(flights.userId, userId))
    .orderBy(asc(flights.id));
  if (selectedFlights.length === 0) {
    throw new ShareEmptyMapError();
  }
  const flightIds = selectedFlights.map(({ id }) => id);
  const selectedStops = await tx
    .select({
      flightId: flightStops.flightId,
      airportId: flightStops.airportId,
      stopOrder: flightStops.stopOrder,
    })
    .from(flightStops)
    .where(eq(flightStops.userId, userId))
    .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder));
  const stopsByFlight = new Map<string, typeof selectedStops>();
  for (const stop of selectedStops) {
    const stops = stopsByFlight.get(stop.flightId) ?? [];
    stops.push(stop);
    stopsByFlight.set(stop.flightId, stops);
  }
  const airportRows = await tx.execute<{
    id: string;
    sourceIdent: string | null;
    icao: string | null;
    iata: string | null;
    localCode: string | null;
    name: string;
    city: string | null;
    latitude: number;
    longitude: number;
    country: string;
    facility: string;
  }>(sql`
    select
      ${airports.id} as id,
      ${airports.sourceIdent} as "sourceIdent",
      ${airports.icao} as icao,
      ${airports.iata} as iata,
      ${airports.localCode} as "localCode",
      ${airports.name} as name,
      ${airports.city} as city,
      ${airports.latitude} as latitude,
      ${airports.longitude} as longitude,
      ${airports.country} as country,
      ${airports.facility} as facility
    from ${airports}
    where ${airports.id} in (
      select ${flights.originAirportId}
      from ${flights}
      where ${flights.userId} = ${userId}::uuid
      union
      select ${flights.destinationAirportId}
      from ${flights}
      where ${flights.userId} = ${userId}::uuid
      union
      select ${flightStops.airportId}
      from ${flightStops}
      where ${flightStops.userId} = ${userId}::uuid
    )
  `);
  const airportById = new Map(airportRows.map((airport) => [airport.id, airport]));
  const routeCounts = new Map<
    string,
    PublicMapProjection["routes"][number]
  >();
  const publicFlights: NonNullable<PublicMapProjection["flights"]> = [];
  for (const flight of selectedFlights) {
    if (
      (flight.kind !== "commercial" && flight.kind !== "private") ||
      (flight.role !== "passenger" && flight.role !== "pilot") ||
      !isPublicDate(flight.date)
    ) {
      throw new ShareValidationError("invalid-flight-facts");
    }
    const stopIds =
      stopsByFlight.get(flight.id)?.map(({ airportId }) => airportId) ?? [
        flight.originAirportId,
        flight.destinationAirportId,
      ];
    const sequence = stopIds.map((airportId) => airportById.get(airportId));
    if (sequence.length < 2 || sequence.some((airport) => !airport)) {
      throw new ShareValidationError("invalid-flight-route");
    }
    const routeIds = sequence.slice(0, -1).map((origin, index) => {
      const destination = sequence[index + 1]!;
      const publicOrigin = publicAirportFromRow(origin!);
      const publicDestination = publicAirportFromRow(destination);
      const routeKey = [
        flight.kind,
        publicAirportKey(publicOrigin),
        publicAirportKey(publicDestination),
      ].join("|");
      const existing = routeCounts.get(routeKey);
      if (existing) existing.flightCount += 1;
      else {
        const id = createHash("md5").update(routeKey).digest("hex");
        routeCounts.set(routeKey, {
          id,
          kind: flight.kind as "commercial" | "private",
          flightCount: 1,
          origin: publicOrigin,
          destination: publicDestination,
        });
      }
      return routeCounts.get(routeKey)!.id;
    });
    publicFlights.push({
      date: flight.date,
      kind: flight.kind,
      role: flight.role,
      aircraft: normalizePublicAircraft([
        flight.aircraftType,
        flight.aircraft,
      ]),
      registration: normalizePublicMetadata(flight.registration),
      routeIds,
    });
  }
  const projection = validatePublicMapProjection({
    schemaVersion: PUBLIC_MAP_PROJECTION_SCHEMA_VERSION,
    owner: { displayName: null },
    summary: {
      flightCount: selectedFlights.length,
      routeCount: routeCounts.size,
    },
    routes: [...routeCounts.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
    flights: publicFlights,
  });
  return {
    flightIds,
    projection,
  };
}

function validatePublicMapProjection(value: unknown): PublicMapProjection {
  try {
    return parsePublicMapProjection(value);
  } catch (error) {
    if (error instanceof PublicMapProjectionValidationError) {
      throw new ShareValidationError("invalid-generated-projection");
    }
    throw error;
  }
}

async function lockOwnerShare(
  tx: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}::uuid::text, 0))`,
  );
}

function normalizePublicAircraft(
  values: Array<string | null>,
): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizePublicMetadata(value);
    if (normalized) {
      unique.set(normalized.toLocaleLowerCase("en-US"), normalized);
    }
  }
  return [...unique.values()];
}

function normalizePublicMetadata(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized &&
    normalized.length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function isPublicMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    normalizePublicMetadata(value) === value
  );
}

function isPublicDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
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

function sanitizeStoredPublicFlights(
  value: unknown,
  routeById: ReadonlyMap<
    string,
    { kind: "commercial" | "private"; flightCount: number }
  >,
): PublicMapProjection["flights"] {
  if (!Array.isArray(value)) throw new ShareValidationError();
  const publicFlights: PublicMapProjection["flights"] = [];
  const referencesByRouteId = new Map<string, number>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !isPublicDate(Reflect.get(candidate, "date")) ||
      (Reflect.get(candidate, "kind") !== "commercial" &&
        Reflect.get(candidate, "kind") !== "private") ||
      (Reflect.get(candidate, "role") !== "passenger" &&
        Reflect.get(candidate, "role") !== "pilot")
    ) {
      throw new ShareValidationError();
    }
    const date = Reflect.get(candidate, "date") as string;
    const kind = Reflect.get(candidate, "kind") as
      | "commercial"
      | "private";
    const role = Reflect.get(candidate, "role") as "passenger" | "pilot";
    const aircraft = Reflect.get(candidate, "aircraft");
    const registration = Reflect.get(candidate, "registration");
    const routeIds = Reflect.get(candidate, "routeIds");
    if (
      !Array.isArray(aircraft) ||
      aircraft.some(
        (item) =>
          typeof item !== "string" ||
          normalizePublicMetadata(item) !== item,
      ) ||
      (registration !== null &&
        (typeof registration !== "string" ||
          normalizePublicMetadata(registration) !== registration)) ||
      !Array.isArray(routeIds) ||
      routeIds.length === 0 ||
      routeIds.some(
        (routeId) =>
          typeof routeId !== "string" ||
          routeById.get(routeId)?.kind !== kind,
      )
    ) {
      throw new ShareValidationError();
    }
    publicFlights.push({
      date,
      kind,
      role,
      aircraft: [...aircraft],
      registration,
      routeIds: [...routeIds],
    });
    for (const routeId of routeIds) {
      referencesByRouteId.set(
        routeId,
        (referencesByRouteId.get(routeId) ?? 0) + 1,
      );
    }
  }
  if (
    [...routeById].some(
      ([routeId, route]) =>
        (referencesByRouteId.get(routeId) ?? 0) !== route.flightCount,
    )
  ) {
    throw new ShareValidationError();
  }
  return publicFlights;
}

function sanitizeStoredPublicRoutes(
  value: unknown,
): PublicMapProjection["routes"] {
  if (!Array.isArray(value)) throw new ShareValidationError();
  const routeIds = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new ShareValidationError();
    }
    const id = Reflect.get(candidate, "id");
    const kind = Reflect.get(candidate, "kind");
    const flightCount = Reflect.get(candidate, "flightCount");
    const origin = Reflect.get(candidate, "origin");
    const destination = Reflect.get(candidate, "destination");
    if (
      typeof id !== "string" ||
      !PUBLIC_ROUTE_ID_PATTERN.test(id) ||
      routeIds.has(id) ||
      (kind !== "commercial" && kind !== "private") ||
      typeof flightCount !== "number" ||
      !Number.isSafeInteger(flightCount) ||
      flightCount < 1
    ) {
      throw new ShareValidationError();
    }
    routeIds.add(id);
    return {
      id,
      kind,
      flightCount,
      origin: sanitizeStoredPublicPlace(origin),
      destination: sanitizeStoredPublicPlace(destination),
    };
  });
}

function sanitizeStoredPublicPlace(
  value: unknown,
): PublicMapProjection["routes"][number]["origin"] {
  if (!value || typeof value !== "object") {
    throw new ShareValidationError();
  }
  const code = Reflect.get(value, "code");
  const name = Reflect.get(value, "name");
  const city = Reflect.get(value, "city");
  const lat = Reflect.get(value, "lat");
  const lon = Reflect.get(value, "lon");
  const country = Reflect.get(value, "country");
  const facility = Reflect.get(value, "facility");
  if (
    typeof code !== "string" ||
    code !== code.trim() ||
    !isPublicAirportCode(code) ||
    !isPublicMetadata(name) ||
    !isPublicMetadata(city) ||
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lon !== "number" ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180 ||
    typeof country !== "string" ||
    country !== country.trim() ||
    !PUBLIC_COUNTRY_PATTERN.test(country) ||
    (facility !== "commercial" &&
      facility !== "general-aviation" &&
      facility !== "airstrip")
  ) {
    throw new ShareValidationError();
  }
  return {
    code,
    name,
    city,
    country,
    lat: normalizePublicZero(lat),
    lon: normalizePublicZero(lon),
    facility,
  };
}

function publicAirportFromRow(
  row: {
    sourceIdent: string | null;
    icao: string | null;
    iata: string | null;
    localCode: string | null;
    name: string;
    city: string | null;
    latitude: number;
    longitude: number;
    country: string;
    facility: string;
  },
): PublicAirport {
  try {
    return sanitizeStoredPublicPlace({
      code: preferredAirportCode(row),
      name: row.name,
      city: row.city ?? row.name,
      country: row.country,
      lat: row.latitude,
      lon: row.longitude,
      facility: row.facility,
    });
  } catch (error) {
    if (error instanceof ShareValidationError) {
      throw new ShareValidationError("invalid-airport-metadata");
    }
    throw error;
  }
}

function publicAirportKey(airport: PublicAirport): string {
  return [
    airport.code,
    airport.country,
    airport.lat,
    airport.lon,
  ].join("|");
}

function normalizePublicZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
