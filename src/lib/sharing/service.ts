import { createHash } from "node:crypto";
import { asc, and, count, eq, sql } from "drizzle-orm";
import { getDb, withUserDb, type DatabaseTransaction } from "@/lib/db";
import {
  airportAliases,
  airports,
  flightStops,
  flights,
  mapShareFlights,
  mapShares,
  users,
} from "@/lib/db/schema";
import { isValidPublicHandle, normalizeUsername } from "@/lib/auth/username";
import {
  airportExactIdentity,
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

const PUBLIC_ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PUBLIC_COUNTRY_PATTERN =
  /^(?:[A-Z]{2}|[\p{L}][\p{L}\p{M} .,'\u2019()&-]{1,79})$/u;
const STORED_MAP_PROJECTION_SCHEMA_VERSION = 2;
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
 * so the snapshot query, the display-code selector, and its tests cannot drift
 * into passing `undefined` for an identifier field.
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
      STORED_MAP_PROJECTION_SCHEMA_VERSION
  ) {
    throw new ShareRepublishRequiredError();
  }
  const { routes: storedRoutes, flights: publicFlights } =
    normalizeStoredPublicProjection(
      Reflect.get(projection, "canonicalRoutes") ??
        Reflect.get(projection, "routes"),
      Reflect.get(projection, "flights"),
    );
  const { routes: publicRoutes, flights: relabelledFlights } =
    await relabelledPublicProjection(storedRoutes, publicFlights);
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
        publicRoutes.length,
    },
    routes: publicRoutes,
    flights: relabelledFlights,
  });
}

export function publicHandleRateLimitKey(identifier: string): string {
  return normalizeUsername(identifier);
}

type AirportLabelRow = Pick<
  PublicAirportRow,
  "sourceIdent" | "icao" | "iata" | "localCode"
> & {
  aliasCode: string;
  id: string;
  latitude: number;
  longitude: number;
};

/**
 * A published projection is frozen JSON: every airport's display code was
 * captured at publish time. Airport codes are labels rather than identities,
 * so the public read re-derives them from the live airport catalog and
 * substitutes the ones that have changed. Already-published maps therefore
 * pick up a display-code correction (Bandon State's `BDY` becoming `S05`)
 * without the owner republishing, without rewriting stored snapshots, and
 * without invalidating the schema-v2 rollback view.
 *
 * A stored airport is only relabelled when exactly one catalog airport carries
 * the published code as an identifier alias *at the published coordinates*.
 * Unknown, ambiguous, or moved airports keep their published label, so this can
 * never invent or cross-assign a code.
 *
 * The relabel is cosmetic, so it fails open: if the catalog lookup errors the
 * published map is still served with its stored labels rather than turning a
 * readable shared map into a 503.
 */
async function relabelledPublicProjection(
  routes: PublicMapProjection["routes"],
  flights: PublicMapProjection["flights"],
): Promise<Pick<PublicMapProjection, "routes" | "flights">> {
  // One lookup for every published label on the map, route endpoints and
  // overflown waypoints alike. Relabelling only the routes would let the same
  // airport render as `S05` on a route and `BDY` on a path through it.
  const codes = [
    ...new Set([
      ...routes.flatMap((route) => [
        route.origin.code.toUpperCase(),
        route.destination.code.toUpperCase(),
      ]),
      ...flights.flatMap((flight) =>
        (flight.routePath ?? []).map((node) =>
          node.airport.code.toUpperCase(),
        ),
      ),
    ]),
  ];
  if (codes.length === 0) return { routes, flights };
  const rows = await airportLabelRows(codes);
  const byCode = new Map<string, AirportLabelRow[]>();
  for (const row of rows) {
    if (
      typeof row?.aliasCode !== "string" ||
      typeof row.latitude !== "number" ||
      typeof row.longitude !== "number"
    ) {
      continue;
    }
    const matches = byCode.get(row.aliasCode) ?? [];
    matches.push(row);
    byCode.set(row.aliasCode, matches);
  }
  if (byCode.size === 0) return { routes, flights };
  return {
    routes: routes.map((route) => ({
      ...route,
      origin: relabelledPublicAirport(route.origin, byCode),
      destination: relabelledPublicAirport(route.destination, byCode),
    })),
    flights: flights.map((flight) =>
      flight.routePath
        ? {
            ...flight,
            routePath: flight.routePath.map((node) => ({
              ...node,
              airport: relabelledPublicAirport(node.airport, byCode),
            })),
          }
        : flight,
    ),
  };
}

function relabelledPublicAirport(
  airport: PublicAirport,
  byCode: Map<string, AirportLabelRow[]>,
): PublicAirport {
  const candidates = (byCode.get(airport.code.toUpperCase()) ?? []).filter(
    (row) =>
      normalizePublicZero(row.latitude) === airport.lat &&
      normalizePublicZero(row.longitude) === airport.lon,
  );
  if (new Set(candidates.map(({ id }) => id)).size !== 1) return airport;
  const code = preferredAirportCode(candidates[0]!);
  return code && code !== airport.code ? { ...airport, code } : airport;
}

/**
 * Reads the catalog rows that carry any of `codes` as an identifier alias.
 *
 * `airport_aliases.code` is written upper-cased by the only writer of that
 * table (`airportIdentifierAliases` upper-cases every alias it emits) and the
 * lookup codes are upper-cased above, so the column is compared directly
 * rather than through `upper(...)`: wrapping it discards the
 * `airport_aliases_code_priority_idx` index and forces a sequential scan on
 * every public map read. This matches how the import repository resolves an
 * alias (`eq(airportAliases.code, normalized)`).
 *
 * A failure here means the *label refresh* is unavailable, not the map. The
 * caller treats an empty result as "nothing to relabel", so an error degrades
 * to the stored published labels instead of failing the whole read.
 */
async function airportLabelRows(
  codes: string[],
): Promise<readonly AirportLabelRow[]> {
  try {
    return await getDb().execute<AirportLabelRow>(sql`
      select
        ${airportAliases.code} as "aliasCode",
        ${airports.id} as id,
        ${airports.sourceIdent} as "sourceIdent",
        ${airports.icao} as icao,
        ${airports.iata} as iata,
        ${airports.localCode} as "localCode",
        ${airports.latitude} as latitude,
        ${airports.longitude} as longitude
      from ${airports}
      join ${airportAliases}
        on ${airportAliases.airportId} = ${airports.id}
      where ${airportAliases.code} in (${sql.join(
        codes.map((code) => sql`${code}`),
        sql`, `,
      )})
    `);
  } catch {
    return [];
  }
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

async function createSnapshot(
  tx: DatabaseTransaction,
  userId: string,
): Promise<{ projection: unknown; flightIds: string[] }> {
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
  // Two reads of the same table, for two different questions.
  //
  // `selectedStops` is landings only and is the *only* input to routes,
  // route legs, and the summary: a shared map's airport, route, and flight
  // counts are claims about where someone has been, and a waypoint is not a
  // place they went.
  //
  // `pathStops` is the full ordered path and feeds only the presentation-only
  // `routePath`. Keeping them as separate queries is what makes it impossible
  // for a waypoint to reach a count by accident.
  const selectedStops = await tx
    .select({
      flightId: flightStops.flightId,
      airportId: flightStops.airportId,
      stopOrder: flightStops.stopOrder,
    })
    .from(flightStops)
    .where(
      and(
        eq(flightStops.userId, userId),
        eq(flightStops.stopKind, "landing"),
      ),
    )
    .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder));
  const pathStops = await tx
    .select({
      flightId: flightStops.flightId,
      airportId: flightStops.airportId,
      stopOrder: flightStops.stopOrder,
      stopKind: flightStops.stopKind,
    })
    .from(flightStops)
    .where(eq(flightStops.userId, userId))
    .orderBy(asc(flightStops.flightId), asc(flightStops.stopOrder));
  const pathStopsByFlight = new Map<string, typeof pathStops>();
  for (const stop of pathStops) {
    const stops = pathStopsByFlight.get(stop.flightId) ?? [];
    stops.push(stop);
    pathStopsByFlight.set(stop.flightId, stops);
  }
  const stopsByFlight = new Map<string, typeof selectedStops>();
  for (const stop of selectedStops) {
    const stops = stopsByFlight.get(stop.flightId) ?? [];
    stops.push(stop);
    stopsByFlight.set(stop.flightId, stops);
  }
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
      ...(publicRoutePath(pathStopsByFlight.get(flight.id), airportById) ?? {}),
      routeLegs,
    });
  }
  const publicProjection = validatePublicMapProjection({
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
    projection: rollbackCompatibleStoredProjection(publicProjection),
  };
}

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
 * logbook without route waypoints publishes a byte-identical snapshot to the
 * one it published before this shipped.
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

function normalizeStoredPublicProjection(
  routeValue: unknown,
  flightValue: unknown,
): Pick<PublicMapProjection, "routes" | "flights"> {
  if (!Array.isArray(routeValue) || routeValue.length === 0) {
    throw new ShareValidationError();
  }
  const storedIds = new Set<string>();
  const storedRoutes = routeValue.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new ShareValidationError();
    }
    const id = Reflect.get(candidate, "id");
    const kind = Reflect.get(candidate, "kind");
    const flightCount = Reflect.get(candidate, "flightCount");
    if (
      typeof id !== "string" ||
      !PUBLIC_ROUTE_ID_PATTERN.test(id) ||
      storedIds.has(id) ||
      (kind !== "commercial" && kind !== "private") ||
      typeof flightCount !== "number" ||
      !Number.isSafeInteger(flightCount) ||
      flightCount < 1
    ) {
      throw new ShareValidationError();
    }
    storedIds.add(id);
    const hasDirection = Object.hasOwn(candidate, "directionMode");
    return {
      id,
      kind,
      flightCount,
      origin: sanitizeStoredPublicPlace(Reflect.get(candidate, "origin")),
      destination: sanitizeStoredPublicPlace(
        Reflect.get(candidate, "destination"),
      ),
      hasDirection,
      forwardFlightCount: Reflect.get(candidate, "forwardFlightCount"),
      reverseFlightCount: Reflect.get(candidate, "reverseFlightCount"),
      directionMode: Reflect.get(candidate, "directionMode"),
    };
  });
  const isLegacy = storedRoutes.every((route) => !route.hasDirection);
  if (!isLegacy && storedRoutes.some((route) => !route.hasDirection)) {
    throw new ShareValidationError();
  }
  const routeReferenceByStoredId = new Map<
    string,
    {
      routeId: string;
      direction: "forward" | "reverse" | "none";
    }
  >();
  let routes: PublicMapProjection["routes"];
  if (isLegacy) {
    const canonicalRoutes = new Map<
      string,
      PublicMapProjection["routes"][number]
    >();
    for (const route of storedRoutes) {
      const originKey = publicAirportKey(route.origin);
      const destinationKey = publicAirportKey(route.destination);
      const sameAirport = originKey === destinationKey;
      const forward = sameAirport || originKey.localeCompare(destinationKey) < 0;
      const first = forward ? route.origin : route.destination;
      const second = forward ? route.destination : route.origin;
      const canonicalKey = JSON.stringify([
        route.kind,
        publicAirportKey(first),
        publicAirportKey(second),
      ]);
      const direction = sameAirport
        ? "none"
        : forward
          ? "forward"
          : "reverse";
      const existing = canonicalRoutes.get(canonicalKey);
      const canonicalId = existing?.id ?? route.id;
      if (existing) {
        existing.flightCount += route.flightCount;
        if (direction === "forward") {
          existing.forwardFlightCount += route.flightCount;
        }
        if (direction === "reverse") {
          existing.reverseFlightCount += route.flightCount;
        }
        existing.directionMode = deriveRouteDirectionMode(
          existing.forwardFlightCount,
          existing.reverseFlightCount,
          sameAirport,
        );
      } else {
        canonicalRoutes.set(canonicalKey, {
          id: canonicalId,
          kind: route.kind,
          flightCount: route.flightCount,
          forwardFlightCount:
            direction === "forward" ? route.flightCount : 0,
          reverseFlightCount:
            direction === "reverse" ? route.flightCount : 0,
          directionMode: deriveRouteDirectionMode(
            direction === "forward" ? route.flightCount : 0,
            direction === "reverse" ? route.flightCount : 0,
            sameAirport,
          ),
          origin: first,
          destination: second,
        });
      }
      routeReferenceByStoredId.set(route.id, {
        routeId: canonicalId,
        direction,
      });
    }
    routes = [...canonicalRoutes.values()].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
  } else {
    routes = storedRoutes.map((route) => {
      const forwardFlightCount = route.forwardFlightCount;
      const reverseFlightCount = route.reverseFlightCount;
      const sameAirport =
        publicAirportKey(route.origin) === publicAirportKey(route.destination);
      if (
        typeof forwardFlightCount !== "number" ||
        !Number.isSafeInteger(forwardFlightCount) ||
        forwardFlightCount < 0 ||
        typeof reverseFlightCount !== "number" ||
        !Number.isSafeInteger(reverseFlightCount) ||
        reverseFlightCount < 0 ||
        route.directionMode !==
          deriveRouteDirectionMode(
            forwardFlightCount,
            reverseFlightCount,
            sameAirport,
          ) ||
        (sameAirport
          ? forwardFlightCount !== 0 || reverseFlightCount !== 0
          : forwardFlightCount + reverseFlightCount !== route.flightCount)
      ) {
        throw new ShareValidationError();
      }
      return {
        id: route.id,
        kind: route.kind,
        flightCount: route.flightCount,
        forwardFlightCount,
        reverseFlightCount,
        directionMode: route.directionMode,
        origin: route.origin,
        destination: route.destination,
      };
    });
  }
  const routeById = new Map(routes.map((route) => [route.id, route]));
  if (!Array.isArray(flightValue)) throw new ShareValidationError();
  const publicFlights: PublicMapProjection["flights"] = flightValue.map(
    (candidate) => {
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
      const kind = Reflect.get(candidate, "kind") as
        | "commercial"
        | "private";
      const aircraft = Reflect.get(candidate, "aircraft");
      const registration = Reflect.get(candidate, "registration");
      if (
        !Array.isArray(aircraft) ||
        aircraft.some((item) => typeof item !== "string") ||
        (registration !== null && typeof registration !== "string")
      ) {
        throw new ShareValidationError();
      }
      let routeLegs: PublicMapProjection["flights"][number]["routeLegs"];
      if (isLegacy) {
        const routeIds = Reflect.get(candidate, "routeIds");
        if (!Array.isArray(routeIds) || routeIds.length === 0) {
          throw new ShareValidationError();
        }
        routeLegs = routeIds.map((routeId) => {
          if (typeof routeId !== "string") throw new ShareValidationError();
          const reference = routeReferenceByStoredId.get(routeId);
          if (!reference || routeById.get(reference.routeId)?.kind !== kind) {
            throw new ShareValidationError();
          }
          return reference;
        });
      } else {
        const storedLegs = Reflect.get(candidate, "routeLegs");
        if (!Array.isArray(storedLegs) || storedLegs.length === 0) {
          throw new ShareValidationError();
        }
        routeLegs = storedLegs.map((leg) => {
          if (!leg || typeof leg !== "object") {
            throw new ShareValidationError();
          }
          const routeId = Reflect.get(leg, "routeId");
          const direction = Reflect.get(leg, "direction");
          if (
            typeof routeId !== "string" ||
            (direction !== "forward" &&
              direction !== "reverse" &&
              direction !== "none") ||
            routeById.get(routeId)?.kind !== kind
          ) {
            throw new ShareValidationError();
          }
          return { routeId, direction };
        });
      }
      if (
        new Set(routeLegs.map(({ routeId }) => routeId)).size !==
        routeLegs.length
      ) {
        throw new ShareValidationError();
      }
      return {
        date: Reflect.get(candidate, "date") as string,
        kind,
        role: Reflect.get(candidate, "role") as "passenger" | "pilot",
        aircraft: normalizePublicAircraft(aircraft),
        registration:
          registration === null
            ? null
            : normalizeRegistrationMetadata(registration) ?? null,
        ...storedRoutePath(Reflect.get(candidate, "routePath")),
        routeLegs,
      };
    },
  );
  return { routes, flights: publicFlights };
}

/**
 * Reads a stored `routePath`, or nothing.
 *
 * A snapshot published before waypoints shipped simply has no such key, and
 * that is not an error — it is a map that renders exactly as it always did.
 * A *present but malformed* path is an error: this projection is what the
 * public map draws, so silently discarding a broken path would publish a
 * flight's route as a straight line and never say why.
 */
function storedRoutePath(
  value: unknown,
): Pick<PublicMapProjection["flights"][number], "routePath"> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length < 2) {
    throw new ShareValidationError();
  }
  const routePath = value.map((node) => {
    if (!node || typeof node !== "object") throw new ShareValidationError();
    const kind = Reflect.get(node, "kind");
    if (!isRouteNodeKind(kind)) throw new ShareValidationError();
    return {
      airport: sanitizeStoredPublicPlace(Reflect.get(node, "airport")),
      kind,
    };
  });
  if (
    routePath[0]!.kind !== "landing" ||
    routePath.at(-1)!.kind !== "landing" ||
    !routePath.some((node) => node.kind === "waypoint")
  ) {
    throw new ShareValidationError();
  }
  return { routePath };
}

function isRouteNodeKind(value: unknown): value is "landing" | "waypoint" {
  return value === "landing" || value === "waypoint";
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

export function publicAirportFromRow(row: PublicAirportRow): PublicAirport {
  try {
    return sanitizeStoredPublicPlace({
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

function publicAirportKey(airport: PublicAirport): string {
  return airportExactIdentity(airport);
}

function normalizePublicZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
