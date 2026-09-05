import { createHash } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import {
  getDb,
  withPublicShareDb,
  withUserDb,
  type DatabaseTransaction,
} from "@/lib/db";
import {
  airports,
  flightStops,
  flights,
  mapShareFlights,
  mapShares,
  users,
} from "@/lib/db/schema";
import { isValidPublicHandle, normalizeUsername } from "@/lib/auth/username";
import {
  deriveRouteDirectionMode,
  type Airport,
  type RouteDirectionMode,
} from "@/lib/flight-data";
import {
  normalizeAircraftMetadata,
  normalizeRegistrationMetadata,
} from "@/lib/flight-metadata";
import {
  isPublicAirportCode,
  preferredAirportCode,
} from "@/lib/airport-preferred-code";
import {
  parsePublicMapProjectionV4,
  PublicMapProjectionValidationError,
} from "./client-projection";

const PUBLIC_COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;

// `PublicMapProjection` (this constant) is the *current* wire contract,
// carrying `routePath`. It must only ever gain a version bump, never a field
// added under an existing number: contract=3 was already shipped without
// `routePath` before it existed, and its exact-key parser (the one already
// running in deployed browsers) rejects any response with an unrecognised
// key outright. `routePath` shipped as contract=4 instead — see
// `PublicMapProjectionV3`/`toV3PublicMapProjection` for the frozen contract=3
// shape that must never change again.
const PUBLIC_MAP_PROJECTION_SCHEMA_VERSION = 4;

type PublicAirport = Pick<
  Airport,
  "code" | "name" | "city" | "country" | "lat" | "lon" | "facility"
>;

/**
 * Exact row shape the public projection reads an airport from. Declared once
 * so the live public query, the display-code selector, and its tests cannot
 * drift into passing `undefined` for an identifier field.
 */
export type PublicAirportRow = {
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
};

export type OwnerShareStatus = {
  enabled: boolean;
  publicHandle: string | null;
  sharePath: string | null;
  enabledAt: string | null;
  disabledAt: string | null;
  /** Flights the live shared map currently covers. */
  sharedFlightCount: number;
  /**
   * @deprecated Same value as `sharedFlightCount`, kept so a browser still
   * running the pre-live bundle does not render an empty count mid-deploy.
   */
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
    forwardFlightCount: number;
    reverseFlightCount: number;
    directionMode: RouteDirectionMode;
    origin: PublicAirport;
    destination: PublicAirport;
  }>;
  flights: Array<{
    date: string;
    kind: "commercial" | "private";
    role: "passenger" | "pilot";
    aircraft: string[];
    registration: string | null;
    /**
     * Ordered presentation-only path, present **only** when the flight has an
     * overflown waypoint. It is the same shape the private map draws, so the
     * shared view reuses `MapRoutePathFlight`/`FlightGlobe` rather than
     * growing a second rendering model.
     *
     * Waypoints stay out of every landing-shaped field: `routes`, `routeLegs`,
     * and the summary are built from landing stops alone, so a shared map's
     * airport, route, and flight counts are byte-identical whether or not a
     * flight carries waypoints. Nothing from the source row travels with it —
     * no flight id, no raw route text — only airports already publishable as
     * route endpoints are.
     */
    routePath?: Array<{
      airport: PublicAirport;
      kind: "landing" | "waypoint";
    }>;
    routeLegs: Array<{
      routeId: string;
      direction: "forward" | "reverse" | "none";
    }>;
  }>;
};

/**
 * The contract=3 wire shape, frozen exactly as it shipped before route
 * waypoints existed: no `routePath`, on any flight, ever. The browsers this
 * contract is served to bundle `parsePublicMapProjection`'s exact-key
 * parser — code that predates and knows nothing about `routePath` — so a new
 * field here is not additive, it is a parse error that blanks the map.
 */
export type PublicMapProjectionV3 = {
  schemaVersion: 3;
  owner: PublicMapProjection["owner"];
  summary: PublicMapProjection["summary"];
  routes: PublicMapProjection["routes"];
  flights: Array<Omit<PublicMapProjection["flights"][number], "routePath">>;
};

export type LegacyPublicMapProjection = {
  schemaVersion: 2;
  owner: PublicMapProjection["owner"];
  summary: PublicMapProjection["summary"];
  routes: Array<
    Pick<
      PublicMapProjection["routes"][number],
      "id" | "kind" | "flightCount" | "origin" | "destination"
    >
  >;
  flights: Array<
    Omit<
      PublicMapProjection["flights"][number],
      "routeLegs" | "routePath"
    > & {
      routeIds: string[];
    }
  >;
};

export class ShareNotFoundError extends Error {}
export class ShareValidationError extends Error {
  constructor(readonly code = "invalid-share-projection") {
    super("Invalid share projection.");
    this.name = "ShareValidationError";
  }
}
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
    // Counted from the owner's *current* flights, because that is what the
    // link shows. Counting membership rows would report the flight set as it
    // stood when sharing was enabled, which is exactly the frozen view this
    // feature removed.
    const [shared] = await tx
      .select({ flightCount: count() })
      .from(flights)
      .where(eq(flights.userId, userId));
    const sharedFlightCount = shared?.flightCount ?? 0;
    if (!share) {
      return {
        enabled: false,
        publicHandle,
        sharePath: null,
        enabledAt: null,
        disabledAt: null,
        sharedFlightCount,
        publishedFlightCount: sharedFlightCount,
      };
    }
    const enabled = Boolean(share.enabledAt && !share.disabledAt);
    return {
      enabled,
      publicHandle,
      sharePath: enabled ? formatHandleSharePath(publicHandle) : null,
      enabledAt: share.enabledAt?.toISOString() ?? null,
      disabledAt: share.disabledAt?.toISOString() ?? null,
      sharedFlightCount,
      publishedFlightCount: sharedFlightCount,
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
    // Enabling derives the map once even though nothing durable depends on
    // it: it is what turns "this logbook cannot be published safely" into an
    // error the owner sees while they are looking at the button, rather than
    // a 503 a stranger sees on the link. It also refuses to publish an empty
    // map, exactly as it did before.
    const rows = await readOwnerMapRows(tx, userId);
    if (rows.flights.length === 0) throw new ShareEmptyMapError();
    const projection = buildPublicMapProjection(rows);
    const now = new Date();
    await tx
      .insert(mapShares)
      .values({
        userId,
        // Deprecated rollback document, never read by the live public path.
        // See `rollbackCompatibleStoredProjection`.
        projection: rollbackCompatibleStoredProjection(projection),
        enabledAt: now,
        disabledAt: null,
      })
      .onConflictDoUpdate({
        target: mapShares.userId,
        set: {
          projection: rollbackCompatibleStoredProjection(projection),
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
    if (inserted[0]?.flightCount !== rows.flights.length) {
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

/**
 * Serves a shared map as a live view of the owner's map right now.
 *
 * Two steps, in this order, and the order is the security boundary. First the
 * handle is resolved to an owner id through `public_share_owner_by_handle`,
 * which answers at all only for an enabled, unrevoked share on a live
 * account. Only then is the projection derived, inside a read-only
 * owner-scoped transaction. An unknown, reserved, disabled, or revoked handle
 * never reaches a row: it fails at resolution with the same generic
 * `ShareNotFoundError` every other miss produces.
 *
 * Nothing stored is consulted. A flight imported, enriched with route
 * waypoints, edited, or deleted a second ago is reflected on the next
 * request, without the owner republishing anything.
 */
export async function getPublicMapProjection(
  identifier: string,
): Promise<PublicMapProjection> {
  const handle = normalizeUsername(identifier);
  if (!handle || !isValidPublicHandle(handle)) {
    throw new ShareNotFoundError();
  }
  const resolved = await getDb().execute<{ ownerId: string | null }>(
    sql`select public_share_owner_by_handle(${handle}) as "ownerId"`,
  );
  const ownerId = resolved[0]?.ownerId;
  if (typeof ownerId !== "string" || !ownerId) throw new ShareNotFoundError();
  return withPublicShareDb(ownerId, async (tx) =>
    buildPublicMapProjection(await readOwnerMapRows(tx, ownerId)),
  );
}

export function publicHandleRateLimitKey(identifier: string): string {
  return normalizeUsername(identifier);
}

/**
 * Downgrades the canonical (contract=4) projection to the contract=3 shape
 * that shipped before route waypoints existed. `routePath` must never appear
 * here — see `PublicMapProjectionV3`. Built by naming fields rather than by
 * spreading, so a field added to the public flight later cannot leak into
 * this response by default, the same discipline `toLegacyPublicMapProjection`
 * uses for contract=2.
 */
export function toV3PublicMapProjection(
  projection: PublicMapProjection,
): PublicMapProjectionV3 {
  return {
    schemaVersion: 3,
    owner: projection.owner,
    summary: projection.summary,
    routes: projection.routes,
    flights: projection.flights.map((flight) => ({
      date: flight.date,
      kind: flight.kind,
      role: flight.role,
      aircraft: flight.aircraft,
      registration: flight.registration,
      routeLegs: flight.routeLegs,
    })),
  };
}

export function toLegacyPublicMapProjection(
  projection: PublicMapProjection,
): LegacyPublicMapProjection {
  const routeIdsByDirection = new Map<
    string,
    Record<"forward" | "reverse" | "none", string>
  >();
  const routes: LegacyPublicMapProjection["routes"] = [];
  for (const route of projection.routes) {
    const ids = {
      forward: legacyRouteId(route.id, "forward"),
      reverse: legacyRouteId(route.id, "reverse"),
      none: legacyRouteId(route.id, "none"),
    };
    routeIdsByDirection.set(route.id, ids);
    if (route.forwardFlightCount > 0) {
      routes.push({
        id: ids.forward,
        kind: route.kind,
        flightCount: route.forwardFlightCount,
        origin: route.origin,
        destination: route.destination,
      });
    }
    if (route.reverseFlightCount > 0) {
      routes.push({
        id: ids.reverse,
        kind: route.kind,
        flightCount: route.reverseFlightCount,
        origin: route.destination,
        destination: route.origin,
      });
    }
    if (route.directionMode === "none") {
      routes.push({
        id: ids.none,
        kind: route.kind,
        flightCount: route.flightCount,
        origin: route.origin,
        destination: route.destination,
      });
    }
  }
  return {
    schemaVersion: 2,
    owner: projection.owner,
    summary: {
      flightCount: projection.summary.flightCount,
      routeCount: routes.length,
    },
    routes,
    // `routePath` is deliberately dropped. A schema-2 response is served to
    // browsers running an already-shipped bundle whose parser rejects an
    // unrecognised key outright, so adding one here would turn a readable
    // shared map into a parse error for exactly the clients this contract
    // exists to keep working. Built by naming the fields rather than by
    // spreading, so a field added to the public flight later cannot leak into
    // this response by default.
    flights: projection.flights.map((flight) => ({
      date: flight.date,
      kind: flight.kind,
      role: flight.role,
      aircraft: flight.aircraft,
      registration: flight.registration,
      routeIds: flight.routeLegs.map(({ routeId, direction }) => {
        const ids = routeIdsByDirection.get(routeId);
        if (!ids) throw new ShareValidationError();
        return ids[direction];
      }),
    })),
  };
}

function legacyRouteId(
  routeId: string,
  direction: "forward" | "reverse" | "none",
): string {
  return createHash("md5")
    .update(JSON.stringify([routeId, direction]))
    .digest("hex");
}

/**
 * Every row the public projection is derived from, for exactly one owner.
 *
 * Read as plain rows and handed to a pure builder so the shape of a shared
 * map can be asserted without a database, and so the read path is provably
 * three bounded owner-scoped queries rather than anything per-flight.
 */
export type OwnerMapRows = {
  flights: readonly OwnerFlightRow[];
  /** Every stop, landings and waypoints, ordered by flight then stop order. */
  stops: readonly OwnerStopRow[];
  airports: ReadonlyArray<PublicAirportRow & { id: string }>;
};

type OwnerFlightRow = {
  id: string;
  date: string;
  kind: string;
  role: string;
  aircraft: string | null;
  aircraftType: string | null;
  registration: string | null;
  originAirportId: string;
  destinationAirportId: string;
};

type OwnerStopRow = {
  flightId: string;
  airportId: string;
  stopOrder: number;
  stopKind: string;
};

/**
 * The one bounded query path a public map read is allowed to take: three
 * owner-scoped statements, no matter how large the logbook is and regardless
 * of how many flights, stops, or airports it contains. Nothing here loops.
 *
 * Every statement carries its own `user_id` predicate even though row-level
 * security already restricts the transaction to this owner. The predicate is
 * what keeps the owner-scoped indices in play; RLS is the thing that makes a
 * mistake in the predicate harmless.
 */
async function readOwnerMapRows(
  tx: DatabaseTransaction,
  userId: string,
): Promise<OwnerMapRows> {
  const ownerFlights = await tx.execute<OwnerFlightRow>(sql`
    select
      ${flights.id} as id,
      ${flights.date} as date,
      ${flights.kind} as kind,
      ${flights.role} as role,
      ${flights.aircraft} as aircraft,
      ${flights.aircraftType} as "aircraftType",
      ${flights.registration} as registration,
      ${flights.originAirportId} as "originAirportId",
      ${flights.destinationAirportId} as "destinationAirportId"
    from ${flights}
    where ${flights.userId} = ${userId}::uuid
    order by ${flights.id} asc
  `);
  const ownerStops = await tx.execute<OwnerStopRow>(sql`
    select
      ${flightStops.flightId} as "flightId",
      ${flightStops.airportId} as "airportId",
      ${flightStops.stopOrder} as "stopOrder",
      ${flightStops.stopKind} as "stopKind"
    from ${flightStops}
    where ${flightStops.userId} = ${userId}::uuid
    order by ${flightStops.flightId} asc, ${flightStops.stopOrder} asc
  `);
  const airportRows = await tx.execute<PublicAirportRow & { id: string }>(sql`
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
  return {
    flights: [...ownerFlights],
    stops: [...ownerStops],
    airports: [...airportRows],
  };
}

/**
 * Builds the public projection from an owner's current rows.
 *
 * Pure, and deliberately so: this is the single definition of what a shared
 * map contains, used both by the public read on every request and by the
 * enable action's up-front validation. There is no second builder that could
 * drift, and no stored document that could disagree with it.
 *
 * An owner with no flights produces an empty map rather than an error — a
 * live view of an empty logbook is empty, not broken.
 */
export function buildPublicMapProjection(
  rows: OwnerMapRows,
): PublicMapProjection {
  // One read of the stops, split two ways for two different questions.
  //
  // `landingsByFlight` is the *only* input to routes, route legs, and the
  // summary: a shared map's airport, route, and flight counts are claims
  // about where someone has been, and a waypoint is not a place they went.
  //
  // `pathByFlight` is the full ordered path and feeds only the
  // presentation-only `routePath`. Splitting on `stopKind` here — rather than
  // trusting a caller to pass the right list — is what keeps a waypoint out
  // of a count.
  const landingsByFlight = new Map<string, OwnerStopRow[]>();
  const pathByFlight = new Map<string, OwnerStopRow[]>();
  for (const stop of rows.stops) {
    const path = pathByFlight.get(stop.flightId) ?? [];
    path.push(stop);
    pathByFlight.set(stop.flightId, path);
    if (stop.stopKind !== "landing") continue;
    const landings = landingsByFlight.get(stop.flightId) ?? [];
    landings.push(stop);
    landingsByFlight.set(stop.flightId, landings);
  }
  const airportById = new Map(
    rows.airports.map((airport) => [airport.id, airport]),
  );
  const routeCounts = new Map<
    string,
    PublicMapProjection["routes"][number]
  >();
  const publicFlights: NonNullable<PublicMapProjection["flights"]> = [];
  for (const flight of rows.flights) {
    if (
      (flight.kind !== "commercial" && flight.kind !== "private") ||
      (flight.role !== "passenger" && flight.role !== "pilot") ||
      !isPublicDate(flight.date)
    ) {
      throw new ShareValidationError("invalid-flight-facts");
    }
    const stopIds =
      landingsByFlight.get(flight.id)?.map(({ airportId }) => airportId) ?? [
        flight.originAirportId,
        flight.destinationAirportId,
      ];
    const sequence = stopIds.map((airportId) => airportById.get(airportId));
    if (sequence.length < 2 || sequence.some((airport) => !airport)) {
      throw new ShareValidationError("invalid-flight-route");
    }
    const routeLegs = sequence.slice(0, -1).map((origin, index) => {
      const destination = sequence[index + 1]!;
      const originRow = origin!;
      const sameAirport = originRow.id === destination.id;
      const isForward =
        sameAirport || originRow.id.localeCompare(destination.id) < 0;
      const first = isForward ? originRow : destination;
      const second = isForward ? destination : originRow;
      const publicOrigin = publicAirportFromRow(first);
      const publicDestination = publicAirportFromRow(second);
      const routeKey = JSON.stringify([
        flight.kind,
        first.id,
        second.id,
      ]);
      const existing = routeCounts.get(routeKey);
      const direction: PublicMapProjection["flights"][number]["routeLegs"][number]["direction"] =
        sameAirport
        ? "none"
        : isForward
          ? "forward"
          : "reverse";
      if (existing) {
        existing.flightCount += 1;
        if (direction === "forward") existing.forwardFlightCount += 1;
        if (direction === "reverse") existing.reverseFlightCount += 1;
        existing.directionMode = deriveRouteDirectionMode(
          existing.forwardFlightCount,
          existing.reverseFlightCount,
          sameAirport,
        );
      } else {
        const id = createHash("md5").update(routeKey).digest("hex");
        routeCounts.set(routeKey, {
          id,
          kind: flight.kind as "commercial" | "private",
          flightCount: 1,
          forwardFlightCount: direction === "forward" ? 1 : 0,
          reverseFlightCount: direction === "reverse" ? 1 : 0,
          directionMode: deriveRouteDirectionMode(
            direction === "forward" ? 1 : 0,
            direction === "reverse" ? 1 : 0,
            sameAirport,
          ),
          origin: publicOrigin,
          destination: publicDestination,
        });
      }
      return { routeId: routeCounts.get(routeKey)!.id, direction };
    });
    publicFlights.push({
      date: flight.date,
      kind: flight.kind,
      role: flight.role,
      aircraft: normalizePublicAircraft([
        flight.aircraftType,
        flight.aircraft,
      ]),
      registration: normalizeRegistrationMetadata(flight.registration) ?? null,
      ...(publicRoutePath(pathByFlight.get(flight.id), airportById) ?? {}),
      routeLegs,
    });
  }
  return validatePublicMapProjection({
    schemaVersion: PUBLIC_MAP_PROJECTION_SCHEMA_VERSION,
    owner: { displayName: null },
    summary: {
      flightCount: rows.flights.length,
      routeCount: routeCounts.size,
    },
    routes: [...routeCounts.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    ),
    flights: publicFlights,
  });
}

/**
 * The deprecated rollback document written to `map_shares.projection` when
 * sharing is enabled.
 *
 * It is never read back: the live path derives the map from current owner
 * rows, so this exists only so that a rolled-back build — which does read the
 * column — still finds a map it can serve instead of an empty share. It is
 * consequently as stale as the last enable, and is not a fallback for the
 * live read.
 */
export function rollbackCompatibleStoredProjection(
  projection: PublicMapProjection,
): unknown {
  const legacy = toLegacyPublicMapProjection(projection);
  return {
    ...legacy,
    canonicalRoutes: projection.routes,
    flights: legacy.flights.map((flight, index) => ({
      ...flight,
      // Carried alongside `routeLegs` for the same reason `canonicalRoutes`
      // is: a rolled-back build reads the stored snapshot with `Reflect.get`
      // and simply never asks for this key, so a published map keeps
      // rendering — landings only — instead of failing to parse.
      ...(projection.flights[index]!.routePath
        ? { routePath: projection.flights[index]!.routePath }
        : {}),
      routeLegs: projection.flights[index]!.routeLegs,
    })),
  };
}

/**
 * The presentation-only path for one flight, or nothing.
 *
 * Returns `undefined` unless the flight actually overflew somewhere, so a
 * logbook without route waypoints produces a byte-identical projection to the
 * one it produced before waypoints shipped.
 */
function publicRoutePath(
  stops:
    | Array<{ airportId: string; stopKind: string }>
    | undefined,
  airportById: Map<string, PublicAirportRow & { id: string }>,
): { routePath: NonNullable<PublicMapProjection["flights"][number]["routePath"]> } | undefined {
  if (!stops || stops.length < 2) return undefined;
  if (!stops.some((stop) => stop.stopKind === "waypoint")) return undefined;
  const path = stops.map((stop) => {
    const airport = airportById.get(stop.airportId);
    if (!airport || !isRouteNodeKind(stop.stopKind)) {
      throw new ShareValidationError("invalid-flight-route");
    }
    return { airport: publicAirportFromRow(airport), kind: stop.stopKind };
  });
  // A path has to start and end where the flight did. A leading or trailing
  // waypoint would mean the drawn line begins somewhere the pilot never was.
  if (path[0]!.kind !== "landing" || path.at(-1)!.kind !== "landing") {
    throw new ShareValidationError("invalid-flight-route");
  }
  return { routePath: path };
}

function validatePublicMapProjection(value: unknown): PublicMapProjection {
  try {
    return parsePublicMapProjectionV4(value);
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
  for (const value of values.slice(0, 16)) {
    const normalized = normalizeAircraftMetadata(value);
    if (normalized) {
      unique.set(normalized.toLocaleLowerCase("en-US"), normalized);
    }
  }
  return [...unique.values()].slice(0, 8);
}

function normalizePublicMetadata(value: string | null): string | null {
  if (
    typeof value !== "string" ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= 100
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

function isRouteNodeKind(value: unknown): value is "landing" | "waypoint" {
  return value === "landing" || value === "waypoint";
}

/**
 * The public airport allowlist, applied to every place on the map.
 *
 * Nothing reaches a shared map except the seven fields named here, and each
 * one has to survive its own check. This is the last gate between the owner's
 * catalog rows and a stranger's browser, so an airport that cannot produce a
 * usable public identifier or clean display metadata fails the read rather
 * than being published with whatever it had.
 */
function sanitizePublicPlace(
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

export function publicAirportFromRow(row: PublicAirportRow): PublicAirport {
  try {
    return sanitizePublicPlace({
      code: preferredAirportCode({
        iata: row.iata,
        localCode: row.localCode,
        icao: row.icao,
        sourceIdent: row.sourceIdent,
      }),
      name: normalizePublicMetadata(row.name),
      city: normalizePublicMetadata(row.city ?? row.name),
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

function normalizePublicZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
