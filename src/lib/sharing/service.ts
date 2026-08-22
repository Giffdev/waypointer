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

const PUBLIC_ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PUBLIC_COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;

export type OwnerShareStatus = {
  enabled: boolean;
  publicHandle: string | null;
  sharePath: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  publishedFlightCount: number;
};

export type PublicMapProjection = {
  owner: { displayName: string | null };
  summary: { flightCount: number; routeCount: number };
  routes: Array<{
    id: string;
    kind: "commercial" | "private";
    flightCount: number;
    origin: { lat: number; lon: number; country: string };
    destination: { lat: number; lon: number; country: string };
  }>;
  flights: Array<{
    date: string;
    kind: "commercial" | "private";
    role: "passenger" | "pilot";
    aircraft: string[];
    registration: string | null;
    routeIds: string[];
  }> | null;
};

export class ShareNotFoundError extends Error {}
export class ShareValidationError extends Error {}
export class ShareEmptyMapError extends Error {}

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
      throw new ShareValidationError();
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
    projection: PublicMapProjection | null;
  }>(sql`select public_map_projection_by_handle(${handle}) as projection`);
  const projection = result[0]?.projection;
  if (!projection) throw new ShareNotFoundError();
  const publicRoutes = sanitizeStoredPublicRoutes(projection.routes);
  const publicFlights = sanitizeStoredPublicFlights(
    projection.flights,
    new Map(
      publicRoutes.map(({ id, kind, flightCount }) => [
        id,
        { kind, flightCount },
      ]),
    ),
  );
  return {
    owner: { displayName: projection.owner.displayName },
    summary: {
      flightCount: projection.summary.flightCount,
      routeCount: projection.summary.routeCount,
    },
    routes: publicRoutes,
    flights: publicFlights,
  };
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
    latitude: number;
    longitude: number;
    country: string;
  }>(sql`
    select
      ${airports.id} as id,
      ${airports.latitude} as latitude,
      ${airports.longitude} as longitude,
      ${airports.country} as country
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
      throw new ShareValidationError();
    }
    const stopIds =
      stopsByFlight.get(flight.id)?.map(({ airportId }) => airportId) ?? [
        flight.originAirportId,
        flight.destinationAirportId,
      ];
    const sequence = stopIds.map((airportId) => airportById.get(airportId));
    if (sequence.length < 2 || sequence.some((airport) => !airport)) {
      throw new ShareValidationError();
    }
    const routeIds = sequence.slice(0, -1).map((origin, index) => {
      const destination = sequence[index + 1]!;
      const coarseOrigin = {
        lat: coarse(origin!.latitude),
        lon: coarse(origin!.longitude),
        country: origin!.country,
      };
      const coarseDestination = {
        lat: coarse(destination.latitude),
        lon: coarse(destination.longitude),
        country: destination.country,
      };
      const routeKey = [
        flight.kind,
        coarseOrigin.lat,
        coarseOrigin.lon,
        coarseDestination.lat,
        coarseDestination.lon,
      ].join("|");
      const existing = routeCounts.get(routeKey);
      if (existing) existing.flightCount += 1;
      else {
        const id = createHash("md5").update(routeKey).digest("hex");
        routeCounts.set(routeKey, {
          id,
          kind: flight.kind as "commercial" | "private",
          flightCount: 1,
          origin: coarseOrigin,
          destination: coarseDestination,
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
  const projection: PublicMapProjection = {
    owner: { displayName: null },
    summary: {
      flightCount: selectedFlights.length,
      routeCount: routeCounts.size,
    },
    routes: [...routeCounts.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
    flights: publicFlights,
  };
  return {
    flightIds,
    projection,
  };
}

async function lockOwnerShare(
  tx: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}::uuid::text, 0))`,
  );
}

function coarse(value: number): number {
  return Math.round(value * 10) / 10;
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
  if (!Array.isArray(value)) return null;
  const publicFlights: NonNullable<PublicMapProjection["flights"]> = [];
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
      return null;
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
      return null;
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
    return null;
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
  const lat = Reflect.get(value, "lat");
  const lon = Reflect.get(value, "lon");
  const country = Reflect.get(value, "country");
  if (
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
    !PUBLIC_COUNTRY_PATTERN.test(country)
  ) {
    throw new ShareValidationError();
  }
  return {
    lat: normalizePublicZero(coarse(lat)),
    lon: normalizePublicZero(coarse(lon)),
    country,
  };
}

function normalizePublicZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
