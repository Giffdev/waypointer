import { createHash, createHmac, randomUUID } from "node:crypto";
import { asc, count, eq, sql } from "drizzle-orm";
import { getDb, withUserDb, type DatabaseTransaction } from "@/lib/db";
import {
  airports,
  flightStops,
  flights,
  mapShareFlights,
  mapShares,
  userProfiles,
  users,
} from "@/lib/db/schema";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ShareSettings = {
  includeDisplayName: boolean;
};

export type EnableMapSharingInput = ShareSettings & {
  previewId: string;
};

export type OwnerShareStatus = {
  enabled: boolean;
  sharePath: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  includeDisplayName: boolean;
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

export type MapSharePreview = {
  previewId: string;
  includeDisplayName: boolean;
  projection: PublicMapProjection;
};

export class ShareNotFoundError extends Error {}
export class ShareValidationError extends Error {}
export class ShareEmptyMapError extends Error {}
export class SharePreviewMismatchError extends Error {}

function sharingSecret(): string {
  const secret =
    process.env.MAP_SHARE_SECRET?.trim() ?? process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("Map sharing secret is not configured.");
  return secret;
}

function capabilityKey(publicId: string, version: number): string {
  return createHmac("sha256", sharingSecret())
    .update(`flight-map-share:${publicId}:${version}`)
    .digest("base64url");
}

function capabilityHash(publicId: string, key: string): string {
  return createHash("sha256").update(`${publicId}.${key}`).digest("hex");
}

function sharePath(publicId: string, version: number): string {
  return formatSharePath(publicId, capabilityKey(publicId, version));
}

export function formatSharePath(publicId: string, key: string): string {
  return `/shared/${publicId}#key=${key}`;
}

export function parseShareSettings(
  input: unknown,
  allowPreviewId = false,
): ShareSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ShareValidationError();
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "includeDisplayName",
          ...(allowPreviewId ? ["previewId"] : []),
        ].includes(key),
    ) ||
    typeof value.includeDisplayName !== "boolean"
  ) {
    throw new ShareValidationError();
  }
  return { includeDisplayName: value.includeDisplayName };
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
    const [selected] = await tx
      .select({ flightCount: count() })
      .from(mapShareFlights)
      .where(eq(mapShareFlights.userId, userId));
    if (!share) {
      return {
        enabled: false,
        sharePath: null,
        enabledAt: null,
        disabledAt: null,
        includeDisplayName: false,
        publishedFlightCount: 0,
      };
    }
    const enabled = Boolean(share.enabledAt && !share.disabledAt);
    return {
      enabled,
      sharePath: enabled
        ? sharePath(share.publicId, share.tokenVersion)
        : null,
      enabledAt: share.enabledAt?.toISOString() ?? null,
      disabledAt: share.disabledAt?.toISOString() ?? null,
      includeDisplayName: share.includeDisplayName,
      publishedFlightCount: selected?.flightCount ?? 0,
    };
  });
}

export async function previewMapSharing(
  userId: string,
  input: unknown,
): Promise<MapSharePreview> {
  const settings = parseShareSettings(input);
  return withUserDb(userId, async (tx) => {
    const snapshot = await createPreview(tx, userId, settings);
    return snapshot.preview;
  });
}

export async function enableMapSharing(
  userId: string,
  input: unknown,
): Promise<OwnerShareStatus> {
  const settings = parseShareSettings(input, true);
  const previewId =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).previewId
      : undefined;
  if (typeof previewId !== "string" || previewId.length !== 64) {
    throw new ShareValidationError();
  }
  await withUserDb(userId, async (tx) => {
    await lockOwnerShare(tx, userId);
    const snapshot = await createPreview(tx, userId, settings, true);
    if (snapshot.preview.previewId !== previewId) {
      throw new SharePreviewMismatchError();
    }
    const [existing] = await tx
      .select()
      .from(mapShares)
      .where(eq(mapShares.userId, userId))
      .limit(1);
    const reactivating = Boolean(existing?.disabledAt);
    const publicId =
      !existing || reactivating ? randomUUID() : existing.publicId;
    const version = existing
      ? existing.tokenVersion + (reactivating ? 1 : 0)
      : 1;
    const key = capabilityKey(publicId, version);
    const now = new Date();
    await tx
      .insert(mapShares)
      .values({
        userId,
        publicId,
        tokenVersion: version,
        tokenHash: capabilityHash(publicId, key),
        includeDisplayName: settings.includeDisplayName,
        scopeType: "selected_flights",
        projection: snapshot.preview.projection,
        enabledAt: now,
        disabledAt: null,
      })
      .onConflictDoUpdate({
        target: mapShares.userId,
        set: {
          ...(reactivating
            ? {
                publicId,
                tokenVersion: version,
                rotatedAt: now,
              }
            : {}),
          tokenHash: capabilityHash(publicId, key),
          includeDisplayName: settings.includeDisplayName,
          scopeType: "selected_flights",
          projection: snapshot.preview.projection,
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
      throw new SharePreviewMismatchError();
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
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(mapShares.userId, userId));
  });
  return getOwnerShareStatus(userId);
}

export async function regenerateMapShare(
  userId: string,
): Promise<OwnerShareStatus> {
  await withUserDb(userId, async (tx) => {
    await lockOwnerShare(tx, userId);
    const [share] = await tx
      .select()
      .from(mapShares)
      .where(eq(mapShares.userId, userId))
      .limit(1);
    if (!share?.enabledAt || share.disabledAt) throw new ShareNotFoundError();
    const version = share.tokenVersion + 1;
    const now = new Date();
    await tx
      .update(mapShares)
      .set({
        tokenVersion: version,
        tokenHash: capabilityHash(
          share.publicId,
          capabilityKey(share.publicId, version),
        ),
        rotatedAt: now,
        updatedAt: now,
      })
      .where(eq(mapShares.userId, userId));
  });
  return getOwnerShareStatus(userId);
}

export async function getPublicMapProjection(
  publicId: string,
  key: string,
): Promise<PublicMapProjection> {
  if (!UUID_PATTERN.test(publicId) || !CAPABILITY_KEY_PATTERN.test(key)) {
    throw new ShareNotFoundError();
  }
  const result = await getDb().execute<{
    projection: PublicMapProjection | null;
  }>(
    sql`select public_map_projection(
      ${publicId}::uuid,
      ${capabilityHash(publicId, key)}
    ) as projection`,
  );
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

export function publicTokenRateLimitKey(
  publicId: string,
  key: string,
): string {
  return capabilityHash(publicId, key).slice(0, 16);
}

async function createPreview(
  tx: DatabaseTransaction,
  userId: string,
  settings: ShareSettings,
  staleOnEmptyMap = false,
): Promise<{ preview: MapSharePreview; flightIds: string[] }> {
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
    if (staleOnEmptyMap) throw new SharePreviewMismatchError();
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
  const [identity] = settings.includeDisplayName
    ? await tx
        .select({
          profileName: userProfiles.displayName,
          accountName: users.name,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.id, userId))
        .limit(1)
    : [];
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
    owner: {
      displayName: settings.includeDisplayName
        ? identity?.profileName ?? identity?.accountName ?? "Waypointer map"
        : null,
    },
    summary: {
      flightCount: selectedFlights.length,
      routeCount: routeCounts.size,
    },
    routes: [...routeCounts.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  const canonical = JSON.stringify({
    flightIds,
    includeDisplayName: settings.includeDisplayName,
    projection,
  });
  return {
    flightIds,
    preview: {
      previewId: createHmac("sha256", sharingSecret())
        .update(`flight-map-share-preview:${userId}:${canonical}`)
        .digest("hex"),
      includeDisplayName: settings.includeDisplayName,
      projection,
    },
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
