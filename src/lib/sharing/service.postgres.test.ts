import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { consumeRateLimit, RateLimitExceededError } from "@/lib/auth/rate-limit";
import { getDb, withUserDb } from "@/lib/db";
import {
  flights,
  mapShareFlights,
  mapShares,
  rateLimits,
} from "@/lib/db/schema";
import {
  disableMapSharing,
  enableMapSharing,
  getPublicMapProjection,
  getOwnerShareStatus,
  previewMapSharing,
  regenerateMapShare,
  ShareNotFoundError,
  SharePreviewMismatchError,
  ShareValidationError,
} from "./service";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const userIds: string[] = [];
const airportIds: string[] = [];
const rateLimitKeys: string[] = [];
let fixtureAdmin: ReturnType<typeof postgres> | undefined;

postgresDescribe("read-only map sharing PostgreSQL boundary", () => {
  beforeAll(() => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
    fixtureAdmin = postgres(migrationUrl, {
      max: 1,
      onnotice: () => {},
    });
  });

  beforeEach(() => {
    process.env.AUTH_SECRET = "integration-test-map-sharing-secret";
  });

  afterEach(async () => {
    for (const userId of userIds.splice(0)) {
      await withUserDb(userId, async (tx) => {
        await tx.delete(mapShareFlights).where(eq(mapShareFlights.userId, userId));
        await tx.delete(mapShares).where(eq(mapShares.userId, userId));
        await tx.delete(flights).where(eq(flights.userId, userId));
      });
      await requireFixtureAdmin()`delete from users where id = ${userId}::uuid`;
    }
    const ids = airportIds.splice(0);
    if (ids.length) {
      await requireFixtureAdmin()`delete from airports where id = any(${ids}::uuid[])`;
    }
    const keys = rateLimitKeys.splice(0);
    if (keys.length) {
      await requireFixtureAdmin()`delete from rate_limits where key = any(${keys}::text[])`;
    }
  });

  afterAll(async () => {
    await fixtureAdmin?.end();
    fixtureAdmin = undefined;
  });

  it("defaults off with hidden identity and requires an exact selected-flight preview", async () => {
    const ownerId = await createOwner("Owner Pilot");
    const [originId, destinationId] = await createAirports();
    const flightId = await createFlight(
      ownerId,
      originId,
      destinationId,
      "Owner secret note",
    );
    const unrelatedFlightId = await createFlight(
      ownerId,
      destinationId,
      originId,
      "Unrelated owner note",
    );

    const emptyPreview = await previewMapSharing(ownerId, {
      flightIds: [],
      includeDisplayName: false,
    });
    expect(emptyPreview).toMatchObject({
      selection: {
        flightIds: [],
        includeDisplayName: false,
        selectedFlightCount: 0,
      },
      projection: {
        owner: { displayName: null },
        summary: { flightCount: 0, routeCount: 0 },
        routes: [],
        flights: [],
      },
    });
    const emptyShare = await enableMapSharing(ownerId, {
      flightIds: [],
      includeDisplayName: false,
      previewId: emptyPreview.previewId,
    });
    expect(emptyShare).toMatchObject({
      enabled: true,
      includeDisplayName: false,
      selectedFlightCount: 0,
      selectedFlightIds: [],
    });
    expect(emptyShare.sharePath).toContain("#key=");
    const emptyCapability = capability(emptyShare.sharePath!);
    expect(
      await getPublicMapProjection(emptyCapability.publicId, emptyCapability.key),
    ).toMatchObject({
      owner: { displayName: null },
      summary: { flightCount: 0, routeCount: 0 },
    });

    const selectedPreview = await previewMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: false,
    });
    expect(selectedPreview.projection).toMatchObject({
      owner: { displayName: null },
      summary: { flightCount: 1, routeCount: 1 },
      routes: [
        {
          kind: "private",
          flightCount: 1,
          origin: { lat: 47.4, lon: -122.3, country: "US" },
          destination: { lat: 40.6, lon: -73.8, country: "US" },
        },
      ],
    });
    await expect(
      enableMapSharing(ownerId, {
        flightIds: [flightId],
        includeDisplayName: true,
        previewId: selectedPreview.previewId,
      }),
    ).rejects.toBeInstanceOf(SharePreviewMismatchError);

    const identityPreview = await previewMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: true,
    });
    expect(identityPreview.projection.owner.displayName).toBe("Owner Pilot");
    const selectedShare = await enableMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: true,
      previewId: identityPreview.previewId,
    });
    expect(selectedShare.selectedFlightIds).toEqual([flightId]);
    const selectedCapability = capability(selectedShare.sharePath!);
    const projection = await getPublicMapProjection(
      selectedCapability.publicId,
      selectedCapability.key,
    );
    expect(projection).toEqual(identityPreview.projection);
    expect(JSON.stringify(projection)).not.toMatch(
      /@example|secret note|registration|flightId|ownerId/i,
    );
    const [ordinaryUpdate] = await withUserDb(ownerId, (tx) =>
      tx
        .update(flights)
        .set({ date: "2026-08-15", updatedAt: new Date() })
        .where(eq(flights.id, unrelatedFlightId))
        .returning({ id: flights.id, date: flights.date }),
    );
    expect(ordinaryUpdate).toEqual({
      id: unrelatedFlightId,
      date: "2026-08-15",
    });
    await expect(
      getPublicMapProjection(
        selectedCapability.publicId,
        selectedCapability.key,
      ),
    ).resolves.toEqual(identityPreview.projection);

    const [selectedUpdate] = await withUserDb(ownerId, (tx) =>
      tx
        .update(flights)
        .set({ kind: "commercial", updatedAt: new Date() })
        .where(eq(flights.id, flightId))
        .returning({ id: flights.id, kind: flights.kind }),
    );
    expect(selectedUpdate).toEqual({ id: flightId, kind: "commercial" });
    await expect(
      getPublicMapProjection(
        selectedCapability.publicId,
        selectedCapability.key,
      ),
    ).rejects.toBeInstanceOf(ShareNotFoundError);

    const [unrelatedAfterSelectedEdit] = await withUserDb(ownerId, (tx) =>
      tx
        .select({ id: flights.id, date: flights.date })
        .from(flights)
        .where(eq(flights.id, unrelatedFlightId)),
    );
    expect(unrelatedAfterSelectedEdit).toEqual({
      id: unrelatedFlightId,
      date: "2026-08-15",
    });

    const deletionPreview = await previewMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: false,
    });
    const deletionShare = await enableMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: false,
      previewId: deletionPreview.previewId,
    });
    const deletionCapability = capability(deletionShare.sharePath!);
    const deleted = await withUserDb(ownerId, (tx) =>
      tx
        .delete(flights)
        .where(eq(flights.id, flightId))
        .returning({ id: flights.id }),
    );
    expect(deleted).toEqual([{ id: flightId }]);
    await expect(
      getPublicMapProjection(
        deletionCapability.publicId,
        deletionCapability.key,
      ),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
    const remaining = await withUserDb(ownerId, (tx) =>
      tx
        .select({ id: flights.id })
        .from(flights)
        .where(eq(flights.id, unrelatedFlightId)),
    );
    expect(remaining).toEqual([{ id: unrelatedFlightId }]);
  });

  it("denies cross-tenant selection and does not include future flights", async () => {
    const ownerId = await createOwner("Owner");
    const otherId = await createOwner("Other");
    const [originId, destinationId] = await createAirports();
    const selectedId = await createFlight(ownerId, originId, destinationId, "selected");
    const otherIdFlight = await createFlight(
      otherId,
      destinationId,
      originId,
      "other",
    );
    await expect(
      previewMapSharing(ownerId, {
        flightIds: [otherIdFlight],
        includeDisplayName: false,
      }),
    ).rejects.toBeInstanceOf(ShareValidationError);
    const preview = await previewMapSharing(ownerId, {
      flightIds: [selectedId],
      includeDisplayName: false,
    });
    const enabledShare = await enableMapSharing(ownerId, {
      flightIds: [selectedId],
      includeDisplayName: false,
      previewId: preview.previewId,
    });
    await createFlight(ownerId, destinationId, originId, "future");
    const selectedRows = await withUserDb(ownerId, (tx) =>
      tx
        .select()
        .from(mapShareFlights)
        .where(eq(mapShareFlights.userId, ownerId)),
    );
    expect(selectedRows.map(({ flightId }) => flightId)).toEqual([selectedId]);
    const shareCapability = capability(enabledShare.sharePath!);
    expect(
      await getPublicMapProjection(shareCapability.publicId, shareCapability.key),
    ).toMatchObject({ summary: { flightCount: 1, routeCount: 1 } });
  });

  it("serializes concurrent enable, rotation, and revocation operations", async () => {
    const ownerId = await createOwner("Concurrent Owner");
    const [originId, destinationId] = await createAirports();
    const flightId = await createFlight(ownerId, originId, destinationId, "note");
    const preview = await previewMapSharing(ownerId, {
      flightIds: [flightId],
      includeDisplayName: false,
    });
    const enableInput = {
      flightIds: [flightId],
      includeDisplayName: false,
      previewId: preview.previewId,
    };
    const enabledShares = await Promise.all(
      Array.from({ length: 4 }, () => enableMapSharing(ownerId, enableInput)),
    );
    expect(enabledShares.every(({ enabled }) => enabled)).toBe(true);
    const initialCapability = capability(enabledShares[0].sharePath!);
    const rotations = await Promise.all(
      Array.from({ length: 4 }, () => regenerateMapShare(ownerId)),
    );
    expect(rotations).toHaveLength(4);
    const latest = capability(
      (await getOwnerShareStatus(ownerId)).sharePath!,
    );
    await expect(
      getPublicMapProjection(initialCapability.publicId, initialCapability.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
    await expect(
      getPublicMapProjection(latest.publicId, latest.key),
    ).resolves.toMatchObject({ summary: { flightCount: 1 } });
    const disabled = await Promise.all(
      Array.from({ length: 4 }, () => disableMapSharing(ownerId)),
    );
    expect(disabled.every(({ enabled }) => !enabled)).toBe(true);
    await expect(
      getPublicMapProjection(latest.publicId, latest.key),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it("locks down the definer function, grants only the runtime role, and denies IDOR writes", async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
    const admin = postgres(migrationUrl, {
      max: 1,
      onnotice: () => {},
    });
    try {
      const [functionSecurity] = await admin<{
        owner: string;
        config: string[];
        acl: string;
      }[]>`
        select
          owner.rolname as owner,
          coalesce(proc.proconfig, array[]::text[]) as config,
          coalesce(proc.proacl::text, '') as acl
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_roles owner on owner.oid = proc.proowner
        where namespace.nspname = 'public'
          and proc.proname = 'public_map_projection'
          and pg_get_function_identity_arguments(proc.oid) = 'requested_public_id uuid, requested_token_hash text'
      `;
      expect(functionSecurity.owner).not.toBe("flight_map_test_app");
      expect(functionSecurity.config).toContain(
        "search_path=pg_catalog, public",
      );
      expect(functionSecurity.acl).not.toMatch(/(?:^|[{,])=X\//);
      const [triggerSecurity] = await admin<{
        owner: string;
        config: string[];
        acl: string;
      }[]>`
        select
          owner.rolname as owner,
          coalesce(proc.proconfig, array[]::text[]) as config,
          coalesce(proc.proacl::text, '') as acl
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        join pg_roles owner on owner.oid = proc.proowner
        where namespace.nspname = 'public'
          and proc.proname = 'invalidate_selected_map_share'
      `;
      expect(triggerSecurity.owner).not.toBe("flight_map_test_app");
      expect(triggerSecurity.config).toContain("search_path=pg_catalog, public");
      expect(triggerSecurity.acl).not.toMatch(/(?:^|[{,])=X\//);
      const [runtimeGrant] = await admin<{ allowed: boolean }[]>`
        select has_function_privilege(
          'flight_map_test_app',
          'public.public_map_projection(uuid,text)',
          'EXECUTE'
        ) as allowed
      `;
      expect(runtimeGrant.allowed).toBe(true);
    } finally {
      await admin.end();
    }

    const ownerId = await createOwner("Owner");
    const attackerId = await createOwner("Attacker");
    const [originId, destinationId] = await createAirports();
    const ownerFlight = await createFlight(
      ownerId,
      originId,
      destinationId,
      "owner",
    );
    const preview = await previewMapSharing(ownerId, {
      flightIds: [ownerFlight],
      includeDisplayName: false,
    });
    await enableMapSharing(ownerId, {
      flightIds: [ownerFlight],
      includeDisplayName: false,
      previewId: preview.previewId,
    });
    const attempted = await withUserDb(attackerId, (tx) =>
      tx
        .update(mapShares)
        .set({ disabledAt: new Date() })
        .where(eq(mapShares.userId, ownerId))
        .returning({ userId: mapShares.userId }),
    );
    expect(attempted).toEqual([]);
  });

  it("persists database rate limits and remains atomic under concurrency", async () => {
    const identity = randomUUID();
    const scope = `sharing-test-${randomUUID()}`;
    rateLimitKeys.push(rateLimitKey(scope, identity));
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        consumeRateLimit(scope, identity, 2, 60_000),
      ),
    );
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      2,
    );
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      3,
    );
    expect(
      outcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        )
        .every(({ reason }) => reason instanceof RateLimitExceededError),
    ).toBe(true);
    const [persisted] = await getDb()
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(eq(rateLimits.key, rateLimitKey(scope, identity)));
    expect(persisted.count).toBe(5);
  });
});

function capability(sharePath: string): { publicId: string; key: string } {
  const url = new URL(sharePath, "https://example.test");
  const key = new URLSearchParams(url.hash.slice(1)).get("key");
  if (!key) throw new Error("Share capability key is missing");
  return { publicId: url.pathname.split("/").at(-1)!, key };
}

function rateLimitKey(scope: string, identity: string): string {
  return createHash("sha256")
    .update(`${scope}\u001f${identity.trim().toLowerCase()}`)
    .digest("hex");
}

async function createOwner(displayName: string): Promise<string> {
  const id = randomUUID();
  userIds.push(id);
  await requireFixtureAdmin()`
    insert into users (id, email, username, name)
    values (
      ${id}::uuid,
      ${`${id}@example.test`},
      ${`pilot-${id.slice(0, 8)}`},
      ${displayName}
    )
  `;
  await requireFixtureAdmin()`
    insert into user_profiles (user_id, display_name)
    values (${id}::uuid, ${displayName})
  `;
  return id;
}

async function createAirports(): Promise<[string, string]> {
  const originId = randomUUID();
  const destinationId = randomUUID();
  airportIds.push(originId, destinationId);
  await requireFixtureAdmin()`
    insert into airports (
      id, icao, name, city, country, latitude, longitude, facility, dataset_version
    )
    values
      (
        ${originId}::uuid,
        ${`K${originId.slice(0, 3).toUpperCase()}`},
        'Private origin',
        'Origin',
        'US',
        47.449,
        -122.309,
        'general-aviation',
        'sharing-test'
      ),
      (
        ${destinationId}::uuid,
        ${`K${destinationId.slice(0, 3).toUpperCase()}`},
        'Private destination',
        'Destination',
        'US',
        40.64,
        -73.779,
        'commercial',
        'sharing-test'
      )
  `;
  return [originId, destinationId];
}

function requireFixtureAdmin(): ReturnType<typeof postgres> {
  if (!fixtureAdmin) throw new Error("PostgreSQL fixture admin is unavailable");
  return fixtureAdmin;
}

async function createFlight(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  notes: string,
): Promise<string> {
  return withUserDb(userId, async (tx) => {
    const [flight] = await tx
      .insert(flights)
      .values({
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-14",
        originAirportId,
        destinationAirportId,
        kind: "private",
        role: "pilot",
        aircraft: "Sensitive aircraft",
        registration: "N12345",
        notes,
      })
      .returning({ id: flights.id });
    return flight.id;
  });
}
