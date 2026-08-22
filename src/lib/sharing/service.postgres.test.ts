import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { withUserDb } from "@/lib/db";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import {
  flights,
  mapShareFlights,
  mapShares,
} from "@/lib/db/schema";
import {
  disableMapSharing,
  enableMapSharing,
  getOwnerShareStatus,
  getPublicMapProjection,
  ShareNotFoundError,
} from "./service";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_SCHEMA_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const userIds: string[] = [];
const airportIds: string[] = [];
let fixtureAdmin: ReturnType<typeof postgres> | undefined;

postgresDescribe("public map sharing PostgreSQL boundary", () => {
  beforeAll(() => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
    fixtureAdmin = postgres(migrationUrl, {
      max: 1,
      onnotice: () => {},
    });
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
  });

  afterAll(async () => {
    await fixtureAdmin?.end();
    fixtureAdmin = undefined;
  });

  it("starts private and publishes every owner flight at the username", async () => {
    const owner = await createOwner("Public Pilot");
    const [originId, destinationId] = await createAirports();
    const firstId = await createFlight(owner.id, originId, destinationId);
    const secondId = await createFlight(owner.id, destinationId, originId);

    await expect(getOwnerShareStatus(owner.id)).resolves.toMatchObject({
      enabled: false,
      publicHandle: owner.username,
      sharePath: null,
    });

    const status = await enableMapSharing(owner.id);
    expect(status).toMatchObject({
      enabled: true,
      publicHandle: owner.username,
      sharePath: `/${owner.username}`,
      publishedFlightCount: 2,
    });
    const [storedShare] = await withUserDb(owner.id, (tx) =>
      tx
        .select({ projection: mapShares.projection })
        .from(mapShares)
        .where(eq(mapShares.userId, owner.id)),
    );
    expect(Reflect.get(storedShare!.projection as object, "schemaVersion")).toBe(
      2,
    );
    const storedFlights = Reflect.get(
      storedShare!.projection as object,
      "flights",
    ) as Array<Record<string, unknown>>;
    expect(storedFlights).toHaveLength(2);
    expect(storedFlights.every((flight) => Array.isArray(flight.routeIds))).toBe(
      true,
    );
    expect(storedFlights.every((flight) => Array.isArray(flight.routeLegs))).toBe(
      true,
    );
    const storedRoutes = Reflect.get(
      storedShare!.projection as object,
      "routes",
    ) as Array<Record<string, unknown>>;
    const canonicalRoutes = Reflect.get(
      storedShare!.projection as object,
      "canonicalRoutes",
    ) as Array<Record<string, unknown>>;
    expect(storedRoutes).toHaveLength(2);
    expect(storedRoutes.every((route) => !("directionMode" in route))).toBe(
      true,
    );
    expect(canonicalRoutes).toEqual([
      expect.objectContaining({
        flightCount: 2,
        forwardFlightCount: 1,
        reverseFlightCount: 1,
        directionMode: "both",
      }),
    ]);
    expect(
      storedFlights.flatMap((flight) => flight.routeIds).toSorted(),
    ).toEqual(storedRoutes.map((route) => route.id).toSorted());
    const memberships = await withUserDb(owner.id, (tx) =>
      tx
        .select({ flightId: mapShareFlights.flightId })
        .from(mapShareFlights)
        .where(eq(mapShareFlights.userId, owner.id)),
    );
    expect(memberships.map(({ flightId }) => flightId).toSorted()).toEqual(
      [firstId, secondId].toSorted(),
    );
    const projection = await getPublicMapProjection(owner.username);
    const originCode = "R47";
    const destinationCode = "SOURCE-ONLY";
    expect(projection).toMatchObject({
      schemaVersion: 3,
      owner: { displayName: null },
      summary: { flightCount: 2, routeCount: 1 },
      flights: [
        expect.objectContaining({
          date: "2026-08-14",
          role: "pilot",
          registration: "N12345",
        }),
        expect.objectContaining({
          date: "2026-08-14",
          role: "pilot",
          registration: "N12345",
        }),
      ],
      routes: [
        expect.objectContaining({
          flightCount: 2,
          forwardFlightCount: 1,
          reverseFlightCount: 1,
          directionMode: "both",
        }),
      ],
    });
    expect(
      [projection.routes[0]!.origin.code, projection.routes[0]!.destination.code]
        .toSorted(),
    ).toEqual([destinationCode, originCode].toSorted());
    const privateFlights = await new DrizzleImportRepository().listFlights(
      owner.id,
    );
    expect(privateFlights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: expect.objectContaining({ code: originCode }),
          destination: expect.objectContaining({ code: destinationCode }),
        }),
      ]),
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("Approximate region");
    expect(serialized).not.toContain(originId);
    expect(serialized).not.toContain(destinationId);
    expect(serialized).not.toMatch(
      /@example|secret note|flightId|ownerId|fingerprint|notes/i,
    );
  });

  it("uses the same username after disable and re-enable", async () => {
    const owner = await createOwner("Toggle Pilot");
    const [originId, destinationId] = await createAirports();
    await createFlight(owner.id, originId, destinationId);

    expect((await enableMapSharing(owner.id)).sharePath).toBe(
      `/${owner.username}`,
    );
    await disableMapSharing(owner.id);
    await expect(
      getPublicMapProjection(owner.username),
    ).rejects.toBeInstanceOf(ShareNotFoundError);
    expect((await enableMapSharing(owner.id)).sharePath).toBe(
      `/${owner.username}`,
    );
    await expect(getPublicMapProjection(owner.username)).resolves.toMatchObject({
      summary: { flightCount: 1 },
    });
  });

  it("normalizes stale whitespace in public airport display metadata", async () => {
    const owner = await createOwner("Whitespace Pilot");
    const [originId, destinationId] = await createAirports(
      "Chewelah Municipal  Airport",
    );
    await createFlight(owner.id, originId, destinationId);

    await expect(enableMapSharing(owner.id)).resolves.toMatchObject({
      enabled: true,
      publishedFlightCount: 1,
    });
    const projection = await getPublicMapProjection(owner.username);
    expect(
      projection.routes.flatMap(({ origin, destination }) => [
        origin.name,
        destination.name,
      ]),
    ).toContain("Chewelah Municipal Airport");
  });

  it("rejects airport display metadata containing control characters", async () => {
    const owner = await createOwner("Control Character Pilot");
    const [originId, destinationId] = await createAirports(
      "Unsafe\tAirport",
    );
    await createFlight(owner.id, originId, destinationId);

    await expect(enableMapSharing(owner.id)).rejects.toMatchObject({
      code: "invalid-airport-metadata",
    });
    await expect(getOwnerShareStatus(owner.id)).resolves.toMatchObject({
      enabled: false,
      publishedFlightCount: 0,
    });
  });

  it("does not cap the complete published map", async () => {
    const owner = await createOwner("Large Map Pilot");
    const [originId, destinationId] = await createAirports();
    await createFlights(owner.id, originId, destinationId, 501);

    await expect(enableMapSharing(owner.id)).resolves.toMatchObject({
      enabled: true,
      publishedFlightCount: 501,
    });
    await expect(getPublicMapProjection(owner.username)).resolves.toMatchObject({
      summary: { flightCount: 501 },
      flights: expect.arrayContaining([
        expect.objectContaining({
          date: "2026-08-14",
          role: "pilot",
        }),
      ]),
    });
  });

  it("omits placeholder aircraft metadata from the public snapshot", async () => {
    const owner = await createOwner("Metadata Pilot");
    const [originId, destinationId] = await createAirports();
    await createFlight(owner.id, originId, destinationId, {
      aircraft: "N/A",
      aircraftType: "-",
      registration: "unknown",
    });

    await enableMapSharing(owner.id);
    await expect(getPublicMapProjection(owner.username)).resolves.toMatchObject({
      flights: [
        expect.objectContaining({
          aircraft: [],
          registration: null,
        }),
      ],
    });
  });

  it("allows an existing generated username to be the public path", async () => {
    const owner = await createOwner("Generated Pilot", true);
    const [originId, destinationId] = await createAirports();
    await createFlight(owner.id, originId, destinationId);

    await expect(enableMapSharing(owner.id)).resolves.toMatchObject({
      publicHandle: owner.username,
      sharePath: `/${owner.username}`,
    });
  });

  it("uses the username index and grants only the current public function", async () => {
    const owner = await createOwner("Indexed Pilot");
    const [originId, destinationId] = await createAirports();
    await createFlight(owner.id, originId, destinationId);
    await enableMapSharing(owner.id);

    const [functionDefinition] = await requireFixtureAdmin()<{
      definition: string;
    }[]>`
      select pg_get_functiondef(proc.oid) as definition
      from pg_proc proc
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and proc.proname = 'public_map_projection_by_handle'
        and pg_get_function_identity_arguments(proc.oid) = 'requested_handle text'
    `;
    expect(functionDefinition.definition).toContain(
      "lower(u.username) = lower(requested_handle)",
    );

    const plan = await requireFixtureAdmin().begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx<{ "QUERY PLAN": string }[]>`
        explain (format text)
        select ms.projection
        from users u
        join map_shares ms on ms.user_id = u.id
        where lower(u.username) = lower(${owner.username})
          and ms.enabled_at is not null
          and ms.disabled_at is null
        limit 1
      `;
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "users_username_unique",
    );

    const [grants] = await requireFixtureAdmin()<{
      currentAllowed: boolean;
      legacyExists: boolean;
    }[]>`
      select
        has_function_privilege(
          'flight_map_test_app',
          'public.public_map_projection_by_handle(text)',
          'EXECUTE'
        ) as "currentAllowed",
        to_regprocedure('public.public_map_projection(uuid,text)') is not null
          as "legacyExists"
    `;
    expect(grants).toEqual({
      currentAllowed: true,
      legacyExists: false,
    });
  });
});

function requireFixtureAdmin(): ReturnType<typeof postgres> {
  if (!fixtureAdmin) throw new Error("PostgreSQL fixture admin is unavailable");
  return fixtureAdmin;
}

async function createOwner(
  displayName: string,
  generated = false,
): Promise<{ id: string; username: string }> {
  const id = randomUUID();
  const username = generated
    ? `pilot_${id.slice(0, 8)}`
    : `test-${id.slice(0, 8)}`;
  userIds.push(id);
  await requireFixtureAdmin()`
    insert into users (id, email, username, name)
    values (${id}::uuid, ${`${id}@example.test`}, ${username}, ${displayName})
  `;
  return { id, username };
}

async function createAirports(
  originName = "Public origin",
): Promise<[string, string]> {
  const originId = randomUUID();
  const destinationId = randomUUID();
  airportIds.push(originId, destinationId);
  await requireFixtureAdmin()`
    insert into airports (
      id, source_ident, name, city, country, latitude, longitude, facility, dataset_version
    )
    values
      (
        ${originId}::uuid,
        'R47',
        ${originName},
        'Origin',
        'US',
        47.449,
        -122.309,
        'general-aviation',
        'sharing-test'
      ),
      (
        ${destinationId}::uuid,
        'SOURCE-ONLY',
        'Public destination',
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

async function createFlight(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  metadata: {
    aircraft?: string;
    aircraftType?: string;
    registration?: string;
  } = {},
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
        aircraft: metadata.aircraft,
        aircraftType: metadata.aircraftType,
        registration: metadata.registration ?? "N12345",
        notes: "secret note",
      })
      .returning({ id: flights.id });
    return flight.id;
  });
}

async function createFlights(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  count: number,
): Promise<void> {
  await withUserDb(userId, (tx) =>
    tx.insert(flights).values(
      Array.from({ length: count }, () => ({
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-14",
        originAirportId,
        destinationAirportId,
        kind: "private" as const,
        role: "pilot" as const,
      })),
    ),
  );
}
