import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, withUserDb } from "../db";
import {
  airports,
  flightOverrides,
  flightSources,
  flights,
  importBatches,
  importRows,
  users,
} from "../db/schema";
import { backfillFlightRoleDefaults } from "./backfill";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const cleanupUsers: string[] = [];
const cleanupAirports: string[] = [];

postgresDescribe("flight role default backfill", () => {
  afterEach(async () => {
    for (const userId of cleanupUsers.splice(0)) {
      await withUserDb(userId, async (tx) => {
        await tx.delete(flightOverrides).where(eq(flightOverrides.userId, userId));
        await tx.delete(flightSources).where(eq(flightSources.userId, userId));
        await tx.delete(flights).where(eq(flights.userId, userId));
        await tx.delete(importRows).where(eq(importRows.userId, userId));
        await tx.delete(importBatches).where(eq(importBatches.userId, userId));
      });
      await getDb().delete(users).where(eq(users.id, userId));
    }
    const airportIds = cleanupAirports.splice(0);
    if (airportIds.length) {
      await getDb().delete(airports).where(inArray(airports.id, airportIds));
    }
  });

  it("is idempotent, tenant-scoped, override-safe, and ambiguity-safe", async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const originId = randomUUID();
    const destinationId = randomUUID();
    cleanupUsers.push(userA, userB);
    cleanupAirports.push(originId, destinationId);
    await getDb().insert(users).values([
      {
        id: userA,
        email: `${userA}@example.test`,
        username: `role-a-${userA.slice(0, 8)}`,
        emailVerified: new Date(),
      },
      {
        id: userB,
        email: `${userB}@example.test`,
        username: `role-b-${userB.slice(0, 8)}`,
        emailVerified: new Date(),
      },
    ]);
    await getDb().insert(airports).values([
      {
        id: originId,
        icao: `K${originId.slice(0, 3).toUpperCase()}`,
        name: "Role Origin",
        city: "Origin",
        country: "US",
        latitude: 40,
        longitude: -75,
        facility: "general-aviation",
        datasetVersion: "role-backfill-test",
      },
      {
        id: destinationId,
        icao: `K${destinationId.slice(0, 3).toUpperCase()}`,
        name: "Role Destination",
        city: "Destination",
        country: "US",
        latitude: 41,
        longitude: -74,
        facility: "general-aviation",
        datasetVersion: "role-backfill-test",
      },
    ]);

    const safe = await seedProvenancedFlight(
      userA,
      originId,
      destinationId,
      "foreflight-v1",
      "ForeFlight",
    );
    const overridden = await seedProvenancedFlight(
      userA,
      originId,
      destinationId,
      "myflightradar24-v1",
      "FlightRadar24",
    );
    await withUserDb(userA, (tx) =>
      tx.insert(flightOverrides).values({
        userId: userA,
        flightId: overridden.flightId,
        field: "role",
        originalValue: "passenger",
        correctedValue: "pilot",
        actor: "test",
      }),
    );
    const ambiguous = await seedProvenancedFlight(
      userA,
      originId,
      destinationId,
      "foreflight-v1",
      "ForeFlight",
    );
    await attachSource(
      userA,
      ambiguous.flightId,
      "myflightradar24-v1",
      "FlightRadar24",
    );
    const otherTenant = await seedProvenancedFlight(
      userB,
      originId,
      destinationId,
      "foreflight-v1",
      "ForeFlight",
    );

    await backfillFlightRoleDefaults(userA);
    await backfillFlightRoleDefaults(userA);

    const rowsA = await withUserDb(userA, (tx) =>
      tx
        .select({
          id: flights.id,
          kind: flights.kind,
          role: flights.role,
          roleOrigin: flights.roleOrigin,
        })
        .from(flights)
        .where(eq(flights.userId, userA)),
    );
    expect(rowsA.find(({ id }) => id === safe.flightId)).toMatchObject({
      kind: "private",
      role: "pilot",
      roleOrigin: "source-default",
    });
    expect(rowsA.find(({ id }) => id === overridden.flightId)).toMatchObject({
      kind: "commercial",
      role: "passenger",
      roleOrigin: "legacy-unresolved",
    });
    expect(rowsA.find(({ id }) => id === ambiguous.flightId)).toMatchObject({
      roleOrigin: "legacy-unresolved",
    });
    const [rowB] = await withUserDb(userB, (tx) =>
      tx
        .select({ id: flights.id, roleOrigin: flights.roleOrigin })
        .from(flights)
        .where(
          and(
            eq(flights.userId, userB),
            eq(flights.id, otherTenant.flightId),
          ),
        ),
    );
    expect(rowB.roleOrigin).toBe("legacy-unresolved");
  });
});

async function seedProvenancedFlight(
  userId: string,
  originAirportId: string,
  destinationAirportId: string,
  adapterId: string,
  sourceType: string,
) {
  const flightId = randomUUID();
  await withUserDb(userId, async (tx) => {
    await tx.insert(flights).values({
      id: flightId,
      userId,
      fingerprint: randomUUID(),
      date: "2026-08-14",
      originAirportId,
      destinationAirportId,
      kind: "commercial",
      role: "passenger",
      roleOrigin: "legacy-unresolved",
      sourceType: "CSV",
    });
  });
  await attachSource(userId, flightId, adapterId, sourceType);
  return { flightId };
}

async function attachSource(
  userId: string,
  flightId: string,
  adapterId: string,
  sourceType: string,
) {
  const batchId = randomUUID();
  const rowId = randomUUID();
  await withUserDb(userId, async (tx) => {
    await tx.insert(importBatches).values({
      id: batchId,
      userId,
      adapterId,
      adapterVersion: 1,
      status: "committed",
      originalObjectKey: `test/${batchId}.csv`,
      originalFileName: "test.csv",
      fileSha256: randomUUID(),
      fileSizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await tx.insert(importRows).values({
      id: rowId,
      userId,
      batchId,
      rowNumber: 1,
      rawSnapshot: null,
      parsed: {
        provenance: {
          adapterId,
          adapterLabel: adapterId,
        },
      },
      validationState: "valid",
      proposedFlight: {},
      userDecision: "accepted",
    });
    await tx.insert(flightSources).values({
      userId,
      flightId,
      batchId,
      importRowId: rowId,
      sourceType,
    });
  });
}
