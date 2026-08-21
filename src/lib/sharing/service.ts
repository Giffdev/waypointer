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
  return {
    owner: { displayName: projection.owner.displayName },
    summary: {
      flightCount: projection.summary.flightCount,
      routeCount: projection.summary.routeCount,
    },
    routes: projection.routes.map((route) => ({
      id: route.id,
      kind: route.kind,
      flightCount: route.flightCount,
      origin: {
        lat: route.origin.lat,
        lon: route.origin.lon,
        country: route.origin.country,
      },
      destination: {
        lat: route.destination.lat,
        lon: route.destination.lon,
        country: route.destination.country,
      },
    })),
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
      kind: flights.kind,
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
  for (const flight of selectedFlights) {
    const stopIds =
      stopsByFlight.get(flight.id)?.map(({ airportId }) => airportId) ?? [
        flight.originAirportId,
        flight.destinationAirportId,
      ];
    const sequence = stopIds.map((airportId) => airportById.get(airportId));
    if (sequence.length < 2 || sequence.some((airport) => !airport)) {
      throw new ShareValidationError();
    }
    sequence.slice(0, -1).forEach((origin, index) => {
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
        routeCounts.set(routeKey, {
          id: createHash("md5").update(routeKey).digest("hex"),
          kind: flight.kind as "commercial" | "private",
          flightCount: 1,
          origin: coarseOrigin,
          destination: coarseDestination,
        });
      }
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
