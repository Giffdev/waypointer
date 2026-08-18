import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { assignAirportSeedIds } from "../../../scripts/airport-seed-plan";
import {
  applyAirportCatalogRefresh,
  type AirportDatabase,
} from "../../../scripts/seed-airports";
import { getDb, withUserDb } from "../db";
import { airportAliases, airports, flights, users } from "../db/schema";
import { DrizzleImportRepository } from "../db/repositories/drizzle-import-repository";
import {
  type AirportReference,
} from "./airport-resolution";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const cleanupAirports: string[] = [];
const cleanupUsers: string[] = [];

postgresDescribe("PostgreSQL airport alias resolution", () => {
  afterEach(async () => {
    for (const userId of cleanupUsers.splice(0)) {
      await withUserDb(userId, (tx) =>
        tx.delete(flights).where(eq(flights.userId, userId)),
      );
      await getDb().delete(users).where(eq(users.id, userId));
    }
    const ids = cleanupAirports.splice(0);
    if (ids.length) await getDb().delete(airports).where(inArray(airports.id, ids));
  });

  it("resolves FAA LIDs and prioritizes IATA over colliding local aliases", async () => {
    const tonasketId = randomUUID();
    const omakId = randomUUID();
    const iataId = randomUUID();
    const localCollisionId = randomUUID();
    const forksId = randomUUID();
    const quillayuteId = randomUUID();
    const equalCollisionAId = randomUUID();
    const equalCollisionBId = randomUUID();
    cleanupAirports.push(
      tonasketId,
      omakId,
      iataId,
      localCollisionId,
      forksId,
      quillayuteId,
      equalCollisionAId,
      equalCollisionBId,
    );
    await getDb().insert(airports).values([
      airportRow(tonasketId, "KW01", null, "W01", "Tonasket Municipal Airport"),
      airportRow(omakId, "KOMK", "OMK", "OMK", "Omak Airport"),
      airportRow(iataId, null, "ZZQ", null, "IATA priority"),
      airportRow(localCollisionId, null, null, "ZZQ", "Local collision"),
      {
        ...airportRow(forksId, null, null, "S18", "Forks Airport"),
        city: "Forks",
        searchKey: "F620",
      },
      {
        ...airportRow(
          quillayuteId,
          "KUIL",
          "UIL",
          "UIL",
          "Quillayute Airport",
        ),
        city: "Quillayute",
        searchKey: "Q430",
      },
      airportRow(equalCollisionAId, null, null, "EQ1", "Equal collision A"),
      airportRow(equalCollisionBId, null, null, "EQ2", "Equal collision B"),
    ]);
    await getDb().insert(airportAliases).values([
      { airportId: tonasketId, code: "KW01", codeType: "ident", priority: 40 },
      { airportId: tonasketId, code: "W01", codeType: "faa-lid", priority: 30 },
      { airportId: omakId, code: "KOMK", codeType: "icao", priority: 10 },
      { airportId: omakId, code: "OMK", codeType: "iata", priority: 20 },
      { airportId: iataId, code: "ZZQ", codeType: "iata", priority: 20 },
      {
        airportId: localCollisionId,
        code: "ZZQ",
        codeType: "faa-lid",
        priority: 30,
      },
      { airportId: forksId, code: "S18", codeType: "faa-lid", priority: 30 },
      { airportId: quillayuteId, code: "KUIL", codeType: "icao", priority: 10 },
      { airportId: quillayuteId, code: "UIL", codeType: "iata", priority: 20 },
      {
        airportId: equalCollisionAId,
        code: "EQUAL",
        codeType: "local",
        priority: 30,
      },
      {
        airportId: equalCollisionBId,
        code: "EQUAL",
        codeType: "local",
        priority: 30,
      },
    ]);
    const repository = new DrizzleImportRepository();
    const userId = randomUUID();
    await expect(repository.resolveIdentifier(userId, "w01")).resolves.toMatchObject({
      status: "resolved",
      airport: { name: "Tonasket Municipal Airport", code: "W01" },
    });
    await expect(repository.resolveIdentifier(userId, "OMK")).resolves.toMatchObject({
      status: "resolved",
      airport: { name: "Omak Airport" },
    });
    await expect(repository.resolveIdentifier(userId, "zzq")).resolves.toMatchObject({
      status: "resolved",
      airport: { name: "IATA priority" },
    });
    await expect(repository.resolveIdentifier(userId, "unknown")).resolves.toEqual({
      status: "not-found",
      identifier: "UNKNOWN",
    });
    await expect(repository.resolveIdentifier(userId, "equal")).resolves.toMatchObject({
      status: "ambiguous",
      identifier: "EQUAL",
      candidates: expect.arrayContaining([
        expect.objectContaining({ name: "Equal collision A" }),
        expect.objectContaining({ name: "Equal collision B" }),
      ]),
    });
    await expect(repository.search(userId, "Forks", 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "S18", name: "Forks Airport" }),
      ]),
    );
    await expect(repository.search(userId, "Quileute", 10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UIL",
          icao: "KUIL",
          name: "Quillayute Airport",
        }),
      ]),
    );
  });

  it("fails closed on crossed identifiers without changing historical flight UUIDs", async () => {
    const airportAId = randomUUID();
    const airportBId = randomUUID();
    const userId = randomUUID();
    const ids = [airportAId, airportBId];
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const sourceA = `SOURCEA${suffix}`;
    const sourceB = `SOURCEB${suffix}`;
    const codeA = `KAA${suffix}`;
    const codeB = `KBB${suffix}`;
    cleanupUsers.push(userId);
    cleanupAirports.push(...ids);
    const references: AirportReference[] = [
      airportReference(sourceA, "Crossed A", 41, -121, codeA),
      airportReference(sourceB, "Crossed B", 42, -122, codeB),
    ];
    await getDb().insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      username: `airport-${userId.slice(0, 8)}`,
      emailVerified: new Date(),
    });
    await getDb().insert(airports).values([
      {
        ...airportRow(airportAId, codeB, null, null, "Crossed A"),
        sourceIdent: sourceA,
        latitude: 41,
        longitude: -121,
      },
      {
        ...airportRow(airportBId, codeA, null, null, "Crossed B"),
        sourceIdent: sourceB,
        latitude: 42,
        longitude: -122,
      },
    ]);
    const flightId = randomUUID();
    await withUserDb(userId, (tx) =>
      tx.insert(flights).values({
        id: flightId,
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-17",
        originAirportId: airportAId,
        destinationAirportId: airportBId,
        kind: "private",
        role: "pilot",
        roleOrigin: "explicit",
        sourceType: "Manual",
      }),
    );
    const before = await airportIdentitySnapshot(ids);

    await expect(async () =>
      assignAirportSeedIds(
        references,
        await getDb()
          .select()
          .from(airports)
          .where(inArray(airports.id, ids)),
        (reference) => reference.gpsCode,
        (reference) => reference.iataCode,
      ),
    ).rejects.toMatchObject({ diagnosticCode: "crossed-identifiers" });

    expect(await airportIdentitySnapshot(ids)).toEqual(before);
    const [historicalFlight] = await withUserDb(userId, (tx) =>
      tx
        .select({
          originAirportId: flights.originAirportId,
          destinationAirportId: flights.destinationAirportId,
        })
        .from(flights)
        .where(eq(flights.id, flightId)),
    );
    expect(historicalFlight).toEqual({
      originAirportId: airportAId,
      destinationAirportId: airportBId,
    });
  });

  it("preserves stable UUIDs, stale rows, rollback, and rerun idempotency", async () => {
    const airportAId = randomUUID();
    const airportBId = randomUUID();
    const staleAirportId = randomUUID();
    const userId = randomUUID();
    const ids = [airportAId, airportBId, staleAirportId];
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const sourceA = `SOURCEA${suffix}`;
    const sourceB = `SOURCEB${suffix}`;
    const codeA = `KAA${suffix}`;
    const codeB = `KBB${suffix}`;
    const staleCode = `STALE${suffix}`;
    const datasetVersion = `airport-refresh-${suffix}`;
    cleanupUsers.push(userId);
    cleanupAirports.push(...ids);
    await getDb().insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      username: `airport-${userId.slice(0, 8)}`,
      emailVerified: new Date(),
    });
    await getDb().insert(airports).values([
      {
        ...airportRow(airportAId, `OLD${suffix}`, null, null, "Stable A"),
        sourceIdent: sourceA,
        latitude: 41,
        longitude: -121,
      },
      {
        ...airportRow(airportBId, codeB, null, null, "Stable B"),
        sourceIdent: sourceB,
        latitude: 42,
        longitude: -122,
      },
      {
        ...airportRow(
          staleAirportId,
          staleCode,
          null,
          null,
          "Historical only",
        ),
        sourceIdent: staleCode,
        latitude: 43,
        longitude: -123,
      },
    ]);
    await getDb().insert(airportAliases).values({
      airportId: staleAirportId,
      code: staleCode,
      codeType: "icao",
      priority: 10,
    });
    const flightId = randomUUID();
    await withUserDb(userId, (tx) =>
      tx.insert(flights).values({
        id: flightId,
        userId,
        fingerprint: randomUUID(),
        date: "2026-08-17",
        originAirportId: airportAId,
        destinationAirportId: airportBId,
        kind: "private",
        role: "pilot",
        roleOrigin: "explicit",
        sourceType: "Manual",
      }),
    );
    const references: AirportReference[] = [
      airportReference(sourceA, "Stable A updated", 41, -121, codeA),
      airportReference(sourceB, "Stable B", 42, -122, codeB),
    ];
    const db = getDb() as unknown as AirportDatabase;

    await expect(
      applyAirportCatalogRefresh(db, references, datasetVersion),
    ).resolves.toMatchObject({
      ids: [airportAId, airportBId],
      matchedExisting: 2,
      created: 0,
    });
    const first = await airportIdentitySnapshot(ids);
    await expect(
      applyAirportCatalogRefresh(db, references, datasetVersion),
    ).resolves.toMatchObject({
      ids: [airportAId, airportBId],
      matchedExisting: 2,
      created: 0,
    });
    expect(await airportIdentitySnapshot(ids)).toEqual(first);

    expect(first.airports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: airportAId,
          sourceIdent: sourceA,
          icao: codeA,
          name: "Stable A updated",
        }),
        expect.objectContaining({
          id: airportBId,
          sourceIdent: sourceB,
          icao: codeB,
        }),
        expect.objectContaining({
          id: staleAirportId,
          sourceIdent: staleCode,
          icao: staleCode,
          name: "Historical only",
        }),
      ]),
    );
    expect(first.aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          airportId: staleAirportId,
          code: staleCode,
          codeType: "icao",
        }),
      ]),
    );
    const [historicalFlight] = await withUserDb(userId, (tx) =>
      tx
        .select({
          originAirportId: flights.originAirportId,
          destinationAirportId: flights.destinationAirportId,
        })
        .from(flights)
        .where(eq(flights.id, flightId)),
    );
    expect(historicalFlight).toEqual({
      originAirportId: airportAId,
      destinationAirportId: airportBId,
    });

    await expect(
      getDb().transaction(async (tx) => {
        await tx
          .update(airports)
          .set({ name: "Must roll back" })
          .where(inArray(airports.id, ids));
        await tx
          .delete(airportAliases)
          .where(inArray(airportAliases.airportId, ids));
        await tx.insert(airportAliases).values({
          airportId: airportAId,
          code: codeA,
          codeType: "invalid",
          priority: 1,
        });
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint_name: "airport_aliases_type_valid",
      },
    });
    expect(await airportIdentitySnapshot(ids)).toEqual(first);
  });
});

async function airportIdentitySnapshot(ids: string[]) {
  const airportRows = await getDb()
    .select({
      id: airports.id,
      sourceIdent: airports.sourceIdent,
      icao: airports.icao,
      iata: airports.iata,
      localCode: airports.localCode,
      name: airports.name,
      latitude: airports.latitude,
      longitude: airports.longitude,
      datasetVersion: airports.datasetVersion,
    })
    .from(airports)
    .where(inArray(airports.id, ids));
  const aliases = await getDb()
    .select({
      airportId: airportAliases.airportId,
      code: airportAliases.code,
      codeType: airportAliases.codeType,
      priority: airportAliases.priority,
    })
    .from(airportAliases)
    .where(inArray(airportAliases.airportId, ids));
  return {
    airports: airportRows.sort((left, right) => left.id.localeCompare(right.id)),
    aliases: aliases.sort((left, right) =>
      `${left.airportId}:${left.code}:${left.codeType}:${left.priority}`.localeCompare(
        `${right.airportId}:${right.code}:${right.codeType}:${right.priority}`,
      ),
    ),
  };
}

function airportReference(
  ident: string,
  name: string,
  latitude: number,
  longitude: number,
  gpsCode?: string,
): AirportReference {
  return {
    ident,
    type: "small_airport",
    name,
    latitude,
    longitude,
    isoCountry: "US",
    municipality: "Test",
    scheduledService: false,
    gpsCode,
  };
}

function airportRow(
  id: string,
  icao: string | null,
  iata: string | null,
  localCode: string | null,
  name: string,
) {
  return {
    id,
    sourceIdent: `TEST-${id}`,
    sourceIdentProvenance: `ourairports-sha256:${"a".repeat(64)}`,
    icao,
    iata,
    localCode,
    name,
    city: "Test",
    country: "US",
    latitude: 48,
    longitude: -119,
    facility: "general-aviation",
    datasetVersion: "airport-alias-test",
  };
}
