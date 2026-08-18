import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
const MAX_SHARED_FLIGHTS = 500;

export type ShareSelection = {
  flightIds: string[];
  includeDisplayName: boolean;
};

export type EnableMapSharingInput = ShareSelection & {
  previewId: string;
};

export type OwnerShareStatus = {
  enabled: boolean;
  sharePath: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  includeDisplayName: boolean;
  scope: "selected_flights";
  selectedFlightCount: number;
  selectedFlightIds: string[];
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
    id: string;
    kind: "commercial" | "private";
    legs: Array<{
      index: number;
      origin: { lat: number; lon: number; country: string };
      destination: { lat: number; lon: number; country: string };
    }>;
  }>;
};

export type MapSharePreview = {
  previewId: string;
  selection: ShareSelection & { selectedFlightCount: number };
  projection: PublicMapProjection;
};

export class ShareNotFoundError extends Error {}
export class ShareValidationError extends Error {}
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

export function parseShareSelection(
  input: unknown,
  allowPreviewId = false,
): ShareSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ShareValidationError();
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "flightIds",
          "includeDisplayName",
          ...(allowPreviewId ? ["previewId"] : []),
        ].includes(key),
    ) ||
    !Array.isArray(value.flightIds) ||
    typeof value.includeDisplayName !== "boolean" ||
    value.flightIds.length > MAX_SHARED_FLIGHTS
  ) {
    throw new ShareValidationError();
  }
  const flightIds = [...new Set(value.flightIds)];
  if (
    flightIds.some(
      (flightId): boolean =>
        typeof flightId !== "string" || !UUID_PATTERN.test(flightId),
    )
  ) {
    throw new ShareValidationError();
  }
  return {
    flightIds: flightIds.toSorted(),
    includeDisplayName: value.includeDisplayName,
  };
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
    const selected = await tx
      .select({ flightId: mapShareFlights.flightId })
      .from(mapShareFlights)
      .where(eq(mapShareFlights.userId, userId));
    if (!share) {
      return {
        enabled: false,
        sharePath: null,
        enabledAt: null,
        disabledAt: null,
        includeDisplayName: false,
        scope: "selected_flights",
        selectedFlightCount: 0,
        selectedFlightIds: [],
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
      scope: "selected_flights",
      selectedFlightCount: selected.length,
      selectedFlightIds: selected.map(({ flightId }) => flightId).toSorted(),
    };
  });
}

export async function previewMapSharing(
  userId: string,
  input: unknown,
): Promise<MapSharePreview> {
  const selection = parseShareSelection(input);
  return withUserDb(userId, (tx) => createPreview(tx, userId, selection));
}

export async function enableMapSharing(
  userId: string,
  input: unknown,
): Promise<OwnerShareStatus> {
  const selection = parseShareSelection(input, true);
  const previewId =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).previewId
      : undefined;
  if (typeof previewId !== "string" || previewId.length !== 64) {
    throw new ShareValidationError();
  }
  await withUserDb(userId, async (tx) => {
    await lockOwnerShare(tx, userId);
    const preview = await createPreview(tx, userId, selection);
    if (preview.previewId !== previewId) throw new SharePreviewMismatchError();
    const [existing] = await tx
      .select()
      .from(mapShares)
      .where(eq(mapShares.userId, userId))
      .limit(1);
    const publicId = existing?.publicId ?? randomUUID();
    const version = existing?.tokenVersion ?? 1;
    const key = capabilityKey(publicId, version);
    const now = new Date();
    await tx
      .insert(mapShares)
      .values({
        userId,
        publicId,
        tokenVersion: version,
        tokenHash: capabilityHash(publicId, key),
        includeDisplayName: selection.includeDisplayName,
        scopeType: "selected_flights",
        projection: preview.projection,
        enabledAt: now,
        disabledAt: null,
      })
      .onConflictDoUpdate({
        target: mapShares.userId,
        set: {
          tokenHash: capabilityHash(publicId, key),
          includeDisplayName: selection.includeDisplayName,
          scopeType: "selected_flights",
          projection: preview.projection,
          enabledAt: now,
          disabledAt: null,
          updatedAt: now,
        },
      });
    await tx
      .delete(mapShareFlights)
      .where(eq(mapShareFlights.userId, userId));
    if (selection.flightIds.length) {
      await tx.insert(mapShareFlights).values(
        selection.flightIds.map((flightId) => ({
          userId,
          flightId,
          selectedAt: now,
        })),
      );
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
  return projection;
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
  selection: ShareSelection,
): Promise<MapSharePreview> {
  const selectedFlights = selection.flightIds.length
    ? await tx
        .select()
        .from(flights)
        .where(
          and(
            eq(flights.userId, userId),
            inArray(flights.id, selection.flightIds),
          ),
        )
        .orderBy(asc(flights.id))
    : [];
  if (selectedFlights.length !== selection.flightIds.length) {
    throw new ShareValidationError();
  }
  const selectedStops = selection.flightIds.length
    ? await tx
        .select()
        .from(flightStops)
        .where(
          and(
            eq(flightStops.userId, userId),
            inArray(flightStops.flightId, selection.flightIds),
          ),
        )
        .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder))
    : [];
  const stopsByFlight = new Map<string, typeof selectedStops>();
  for (const stop of selectedStops) {
    const stops = stopsByFlight.get(stop.flightId) ?? [];
    stops.push(stop);
    stopsByFlight.set(stop.flightId, stops);
  }
  const airportIds = [
    ...new Set(
      selectedFlights.flatMap((flight) =>
        stopsByFlight.get(flight.id)?.map(({ airportId }) => airportId) ?? [
          flight.originAirportId,
          flight.destinationAirportId,
        ],
      ),
    ),
  ];
  const airportRows = airportIds.length
    ? await tx.select().from(airports).where(inArray(airports.id, airportIds))
    : [];
  const airportById = new Map(airportRows.map((airport) => [airport.id, airport]));
  const [identity] = selection.includeDisplayName
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
  const publicFlights: PublicMapProjection["flights"] = [];
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
    const legs = sequence.slice(0, -1).map((origin, index) => {
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
      return {
        index,
        origin: coarseOrigin,
        destination: coarseDestination,
      };
    });
    publicFlights.push({
      id: createHash("sha256")
        .update(`shared-flight:${userId}:${flight.id}`)
        .digest("hex")
        .slice(0, 24),
      kind: flight.kind as "commercial" | "private",
      legs,
    });
  }
  const projection: PublicMapProjection = {
    owner: {
      displayName: selection.includeDisplayName
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
    flights: publicFlights,
  };
  const canonical = JSON.stringify({
    flightIds: selection.flightIds,
    includeDisplayName: selection.includeDisplayName,
    projection,
  });
  return {
    previewId: createHmac("sha256", sharingSecret())
      .update(`flight-map-share-preview:${userId}:${canonical}`)
      .digest("hex"),
    selection: {
      ...selection,
      selectedFlightCount: selection.flightIds.length,
    },
    projection,
  };
}

async function lockOwnerShare(
  tx: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
  );
}

function coarse(value: number): number {
  return Math.round(value * 10) / 10;
}
