import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, withUserDb } from "@/lib/db";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import {
  airportAliases,
  airports,
  flightStops,
  flights,
  importBatches,
  importRows,
  flightSources,
  users,
} from "@/lib/db/schema";
import { aggregateStatsSlice, type StatsPeriod } from "@/lib/flight-statistics";
import { statsFactsFromFlights } from "@/lib/flight-insights";
import { commitImportBatch, decideImportRows, getUserImportBatch } from "./service";
import { stageFlightImport } from "./worker";
import { isAirportNamespaceMatch } from "./route-normalization";
import {
  ACCEPTED_DUPLICATE_FINGERPRINT_VERSION,
  isAcceptedDuplicateFingerprintVersion,
  ROW_FINGERPRINT_VERSION,
} from "./fingerprint";
import { IMPORTER_PIPELINE_VERSION } from "./version";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;

const cleanupUsers: string[] = [];
const cleanupAirports: string[] = [];

type SeededAirport = { id: string; code: string };

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  cleanupUsers.push(userId);
  await getDb().insert(users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
    username: `wash${userId.replaceAll("-", "").slice(0, 12)}`,
    emailVerified: new Date(),
  });
  return userId;
}

// Seeds ICAO-namespace airports. The route classifier only promotes tokens that
// resolve through an airport-namespace alias, so the codeType matters here.
async function seedAirports(
  codes: string[],
  codeType: "icao" | "iata" = "icao",
): Promise<SeededAirport[]> {
  const seeded = codes.map((code) => ({ id: randomUUID(), code }));
  cleanupAirports.push(...seeded.map(({ id }) => id));
  await getDb()
    .insert(airports)
    .values(
      seeded.map(({ id, code }, index) => ({
        id,
        icao: codeType === "icao" ? code : null,
        iata: codeType === "iata" ? code : null,
        name: `Test ${code}`,
        city: `City ${code}`,
        country: "US",
        latitude: 40 + index,
        longitude: -120 + index,
        facility: "general-aviation" as const,
        datasetVersion: "integration-test",
      })),
    );
  await getDb()
    .insert(airportAliases)
    .values(
      seeded.map(({ id, code }) => ({
        airportId: id,
        code,
        codeType,
        priority: 10,
      })),
    );
  return seeded;
}

function foreflightCsv(flightRows: string[], header = "Date,AircraftID,From,To,Route,Distance,TimeOut,TotalTime"): string {
  return [
    "ForeFlight Logbook Import",
    "",
    "Aircraft Table",
    "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)",
    "SYNTH-A,C172,2020,Example Aviation,Trainer,Fixed Tricycle,Reciprocating,airplane,Airplane Single Engine Land",
    "Flights Table",
    header,
    ...flightRows,
  ].join("\n");
}

/**
 * A letter-only synthetic code suffix.
 *
 * Hex suffixes are not safe for codes that go into a `Route` cell: the
 * classifier rejects airway shapes (`[VJQTAB]\d{1,3}`) *before* any catalog
 * lookup, so a randomly all-numeric suffix behind a `B` produced `B123` and
 * the token was refused for a reason the test was not about. That failed
 * roughly one run in ten.
 */
function alphaSuffix(): string {
  const letters = "CDEFGHKLMNPRSUWXYZ";
  return Array.from(
    { length: 3 },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");
}

function upload(fileName: string, content: string) {  return {
    fileName,
    mimeType: "text/csv",
    sizeBytes: Buffer.byteLength(content),
    content,
  };
}

async function stageAndCommitAll(
  userId: string,
  repository: DrizzleImportRepository,
  content: string,
  fileName: string,
) {
  const staged = await stageFlightImport(
    userId,
    {
      fileName,
      mimeType: "text/csv",
      sizeBytes: Buffer.byteLength(content),
      content,
    },
    { imports: repository, flights: repository, airports: repository },
  );
  const detail = await getUserImportBatch(userId, staged.batchId, 1, 100, repository);
  await decideImportRows(
    userId,
    staged.batchId,
    {
      decisions:
        detail?.rows.rows.map((row) => ({
          rowId: row.id,
          action: row.commitReady ? ("accepted" as const) : ("skipped" as const),
          duplicateResolution: row.duplicateCandidate
            ? ("accept_new" as const)
            : undefined,
        })) ?? [],
    },
    repository,
  );
  const committed = await commitImportBatch(userId, staged.batchId, repository, repository);
  return { staged, detail, committed };
}

postgresDescribe("PostgreSQL import identity and route waypoints", () => {
  afterEach(async () => {
    for (const userId of cleanupUsers.splice(0)) {
      await withUserDb(userId, async (tx) => {
        await tx.delete(flightSources).where(eq(flightSources.userId, userId));
        await tx.delete(flights).where(eq(flights.userId, userId));
        await tx.delete(importRows).where(eq(importRows.userId, userId));
        await tx.delete(importBatches).where(eq(importBatches.userId, userId));
      });
      await getDb().delete(users).where(eq(users.id, userId));
    }
    const airportIds = cleanupAirports.splice(0);
    if (airportIds.length > 0) {
      await getDb().delete(airports).where(inArray(airports.id, airportIds));
    }
  });

  it("persists a Route airport as stop_kind='waypoint' without touching landing statistics", async () => {
    const userId = await createUser("route-waypoint");
    const suffix = alphaSuffix();
    const [origin, waypoint, destination] = await seedAirports([
      `K${suffix}`,
      `R${suffix}`,
      `P${suffix}`,
    ]);
    const repository = new DrizzleImportRepository();

    // Baseline: the same leg with no Route column at all.
    const baselineUserId = await createUser("route-waypoint-baseline");
    await stageAndCommitAll(
      baselineUserId,
      repository,
      foreflightCsv([
        `2026-03-01,SYNTH-A,${origin.code},${destination.code},,120,9:00,1.5`,
      ]),
      "baseline.csv",
    );
    const baselineFlights = await repository.listFlights(baselineUserId);

    await stageAndCommitAll(
      userId,
      repository,
      foreflightCsv([
        `2026-03-01,SYNTH-A,${origin.code},${destination.code},${origin.code} ${waypoint.code} ${destination.code},120,9:00,1.5`,
      ]),
      "with-route.csv",
    );

    const stops = await withUserDb(userId, (tx) =>
      tx
        .select({
          airportId: flightStops.airportId,
          stopOrder: flightStops.stopOrder,
          stopKind: flightStops.stopKind,
          sourceField: flightStops.sourceField,
        })
        .from(flightStops)
        .where(eq(flightStops.userId, userId))
        .orderBy(flightStops.stopOrder),
    );

    expect(stops).toEqual([
      expect.objectContaining({
        airportId: origin.id,
        stopKind: "landing",
        sourceField: "endpoint",
      }),
      expect.objectContaining({
        airportId: waypoint.id,
        stopKind: "waypoint",
        sourceField: "route",
      }),
      expect.objectContaining({
        airportId: destination.id,
        stopKind: "landing",
        sourceField: "endpoint",
      }),
    ]);

    const [flight] = await repository.listFlights(userId);
    // airportSequence is the landing spine and drives every statistic.
    expect(flight.airportSequence?.map(({ code }) => code)).toEqual([
      origin.code,
      destination.code,
    ]);
    // routePath is presentation only and carries the waypoint.
    expect(flight.routePath?.map(({ airport, kind }) => [airport.code, kind])).toEqual([
      [origin.code, "landing"],
      [waypoint.code, "waypoint"],
      [destination.code, "landing"],
    ]);
    expect(flight.routeRaw).toContain(waypoint.code);

    const period: StatsPeriod = {
      preset: "any",
      startDate: "2026-01-01",
      endDateExclusive: "2027-01-01",
      isPartial: false,
      elapsedDays: 365,
    };
    const withWaypoint = aggregateStatsSlice(
      statsFactsFromFlights(await repository.listFlights(userId)),
      period,
    );
    const withoutWaypoint = aggregateStatsSlice(
      statsFactsFromFlights(baselineFlights),
      period,
    );
    expect(withWaypoint.metrics.uniqueAirports.value).toBe(
      withoutWaypoint.metrics.uniqueAirports.value,
    );
    expect(withWaypoint.metrics.uniqueAirports.value).toBe(2);
    expect(withWaypoint.metrics).toEqual(withoutWaypoint.metrics);
  });

  it("does not downgrade a duplicate because a waypoint airport cannot be rendered", async () => {
    // Duplicate assessment used to check resolvability across the *whole*
    // path. A single overflown airport whose catalog metadata became unusable
    // then suppressed the candidate's proposal, which drops every route and
    // temporal signal — so a real duplicate scored as new and the pilot got a
    // second copy of a flight, because of a rendering problem at a place they
    // never landed.
    const userId = await createUser("waypoint-duplicate");
    const suffix = alphaSuffix();
    const [origin, waypoint, destination] = await seedAirports([
      `K${suffix}`,
      `R${suffix}`,
      `P${suffix}`,
    ]);
    const repository = new DrizzleImportRepository();

    await stageAndCommitAll(
      userId,
      repository,
      foreflightCsv([
        `2026-04-02,SYNTH-A,${origin.code},${destination.code},${origin.code} ${waypoint.code} ${destination.code},120,9:00,1.5`,
      ]),
      "committed.csv",
    );
    expect(await repository.listFlights(userId)).toHaveLength(1);

    // The waypoint's catalog row loses every public identifier, so it can no
    // longer be turned into a proposal airport. The landings are untouched.
    await getDb()
      .delete(airportAliases)
      .where(eq(airportAliases.airportId, waypoint.id));
    await getDb()
      .update(airports)
      .set({
        icao: null,
        iata: null,
        localCode: null,
        sourceIdent: null,
        sourceIdentProvenance: null,
      })
      .where(eq(airports.id, waypoint.id));

    // A near-duplicate, not an exact one: the departure time differs, so the
    // decision has to come from the route and temporal signals rather than a
    // fingerprint or source-row-key hit.
    const staged = await stageFlightImport(
      userId,
      upload(
        "near-duplicate.csv",
        foreflightCsv([
          `2026-04-02,SYNTH-A,${origin.code},${destination.code},,120,9:30,1.5`,
        ]),
      ),
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await getUserImportBatch(
      userId,
      staged.batchId,
      1,
      100,
      repository,
    );
    const [row] = detail?.rows.rows ?? [];
    expect(row).toBeDefined();
    expect(row.duplicateCandidate?.scope).toBe("existing-flight");
    expect(
      row.duplicateCandidate?.signals.map(({ code }) => code),
    ).toContain("same-route");
  });

  it("keeps two same-day same-route blank-time rows as distinct flights", async () => {    const userId = await createUser("blank-time-legs");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination] = await seedAirports([`K${suffix}`, `P${suffix}`]);
    const repository = new DrizzleImportRepository();

    const { detail } = await stageAndCommitAll(
      userId,
      repository,
      foreflightCsv([
        `2026-04-01,SYNTH-A,${origin.code},${destination.code},,60,,0.8`,
        `2026-04-01,SYNTH-A,${origin.code},${destination.code},,60,,0.8`,
      ]),
      "blank-times.csv",
    );

    expect(detail?.rows.rows).toHaveLength(2);
    const fingerprints = new Set(
      detail?.rows.rows.map((row) => row.rowFingerprint?.value),
    );
    // Both rows are blank-TimeOut, same date, same route, same tail. Before v3
    // they produced one digest and the unique index silently kept one flight.
    expect(fingerprints.size).toBe(2);
    // They may still be surfaced as a fuzzy pair for the pilot to judge, but
    // they must never be treated as the same source row and auto-skipped.
    expect(
      detail?.rows.rows.every(
        (row) =>
          !row.duplicateCandidate?.signals.some(
            ({ code }) => code === "exact-fingerprint",
          ),
      ),
    ).toBe(true);
    expect(
      detail?.rows.rows.every(
        (row) => row.duplicateCandidate?.resolution !== "skip_as_duplicate",
      ),
    ).toBe(true);
    expect(await repository.listFlights(userId)).toHaveLength(2);
  });

  it("keeps row identity stable when an unrelated row is inserted above", async () => {
    const userId = await createUser("stable-identity");
    const otherUserId = await createUser("stable-identity-shifted");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination, extra] = await seedAirports([
      `K${suffix}`,
      `P${suffix}`,
      `Q${suffix}`,
    ]);
    const repository = new DrizzleImportRepository();

    const targetRow = `2026-05-02,SYNTH-A,${origin.code},${destination.code},,60,,0.9`;
    const first = await stageFlightImport(
      userId,
      upload("original.csv", foreflightCsv([targetRow])),
      { imports: repository, flights: repository, airports: repository },
    );
    const second = await stageFlightImport(
      otherUserId,
      upload(
        "shifted.csv",
        foreflightCsv([
          `2026-05-01,SYNTH-A,${origin.code},${extra.code},,45,,0.4`,
          targetRow,
        ]),
      ),
      { imports: repository, flights: repository, airports: repository },
    );

    const firstRows =
      (await getUserImportBatch(userId, first.batchId, 1, 100, repository))?.rows
        .rows ?? [];
    const secondRows =
      (await getUserImportBatch(otherUserId, second.batchId, 1, 100, repository))
        ?.rows.rows ?? [];

    // Same content, one unrelated row above it. rowNumber moved; identity must not.
    const targetAtRowOne = secondRows[1]!;
    expect(firstRows[0]!.rowNumber).not.toBe(targetAtRowOne.rowNumber);
    expect(targetAtRowOne.provenance.sourceRowKey).toBeDefined();
    expect(secondRows[0]!.provenance.sourceRowKey).not.toBe(
      targetAtRowOne.provenance.sourceRowKey,
    );

    const reuploaded = await stageFlightImport(
      otherUserId,
      upload(
        "shifted-again.csv",
        foreflightCsv([
          `2026-05-01,SYNTH-A,${origin.code},${extra.code},,45,,0.4`,
          `2026-04-30,SYNTH-A,${destination.code},${extra.code},,45,,0.4`,
          targetRow,
        ]),
      ),
      { imports: repository, flights: repository, airports: repository },
    );
    const reuploadedRows =
      (await getUserImportBatch(otherUserId, reuploaded.batchId, 1, 100, repository))
        ?.rows.rows ?? [];
    const targetAtRowTwo = reuploadedRows[2]!;
    expect(targetAtRowTwo.rowNumber).not.toBe(targetAtRowOne.rowNumber);
    expect(targetAtRowTwo.provenance.sourceRowKey).toBe(
      targetAtRowOne.provenance.sourceRowKey,
    );
    // TimeOut is blank on this row, so the v3 digest carries sourceRowKey. If the
    // key had been ordinal-derived, this reimport would look like a new flight.
    expect(targetAtRowTwo.rowFingerprint?.value).toBe(
      targetAtRowOne.rowFingerprint?.value,
    );
  });

  it("reuses a same-version batch and restages the same bytes under a newer importer version", async () => {
    const userId = await createUser("version-reuse");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination] = await seedAirports([`K${suffix}`, `P${suffix}`]);
    const repository = new DrizzleImportRepository();
    const content = foreflightCsv([
      `2026-06-01,SYNTH-A,${origin.code},${destination.code},,60,10:00,1.1`,
    ]);
    const upload = {
      fileName: "versioned.csv",
      mimeType: "text/csv",
      sizeBytes: Buffer.byteLength(content),
      content,
    };

    const first = await stageFlightImport(userId, upload, {
      imports: repository,
      flights: repository,
      airports: repository,
    });
    const reused = await stageFlightImport(userId, upload, {
      imports: repository,
      flights: repository,
      airports: repository,
    });
    expect(reused.batchId).toBe(first.batchId);

    const [persisted] = await withUserDb(userId, (tx) =>
      tx
        .select({ importerVersion: importBatches.importerVersion })
        .from(importBatches)
        .where(eq(importBatches.id, first.batchId)),
    );
    expect(persisted.importerVersion).toBe(IMPORTER_PIPELINE_VERSION);

    // Simulate the batch having been staged by an older importer, exactly as an
    // upload from before this deploy would look.
    await withUserDb(userId, (tx) =>
      tx
        .update(importBatches)
        .set({ importerVersion: IMPORTER_PIPELINE_VERSION - 1 })
        .where(
          and(eq(importBatches.userId, userId), eq(importBatches.id, first.batchId)),
        ),
    );

    const restaged = await stageFlightImport(userId, upload, {
      imports: repository,
      flights: repository,
      airports: repository,
    });
    expect(restaged.batchId).not.toBe(first.batchId);
    const [restagedBatch] = await withUserDb(userId, (tx) =>
      tx
        .select({ importerVersion: importBatches.importerVersion })
        .from(importBatches)
        .where(eq(importBatches.id, restaged.batchId)),
    );
    expect(restagedBatch.importerVersion).toBe(IMPORTER_PIPELINE_VERSION);
    // Both rows coexist: the partial unique index is scoped by importer version.
    const batchCount = await withUserDb(userId, (tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(importBatches)
        .where(eq(importBatches.userId, userId)),
    );
    expect(batchCount[0].total).toBe(2);
  });

  it("auto-skips a true cross-batch reimport of the same source row", async () => {
    const userId = await createUser("cross-batch-reimport");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination] = await seedAirports([`K${suffix}`, `P${suffix}`]);
    const repository = new DrizzleImportRepository();
    const row = `2026-07-04,SYNTH-A,${origin.code},${destination.code},,60,11:15,1.3`;

    await stageAndCommitAll(userId, repository, foreflightCsv([row]), "first.csv");
    expect(await repository.listFlights(userId)).toHaveLength(1);

    const second = await stageFlightImport(
      userId,
      // Same source row, different surrounding bytes so the file fingerprint differs.
      upload("second.csv", `${foreflightCsv([row])}\n`),
      { imports: repository, flights: repository, airports: repository },
    );
    const secondDetail = await getUserImportBatch(
      userId,
      second.batchId,
      1,
      100,
      repository,
    );
    const [reimported] = secondDetail?.rows.rows ?? [];
    expect(reimported.validationState).toBe("duplicate");
    expect(reimported.duplicateCandidate?.signals.map(({ code }) => code)).toContain(
      "exact-fingerprint",
    );
  });

  it("commits an accept_new duplicate as a second flight without a source-row-key collision", async () => {
    // `accept_new` deliberately creates a *second* flight for one source row.
    // If it also claimed that row's `source_row_key`, the partial unique index
    // `flights_user_source_row_key_unique` rejected the insert,
    // `onConflictDoNothing` swallowed it, the fingerprint re-lookup missed
    // (the accepted-duplicate digest is different by design), and the commit
    // died with an opaque "Committed flight could not be resolved" — a 500 on
    // a decision the user explicitly made.
    const userId = await createUser("accept-new-duplicate");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination] = await seedAirports([`K${suffix}`, `P${suffix}`]);
    const repository = new DrizzleImportRepository();
    const row = `2026-09-01,SYNTH-A,${origin.code},${destination.code},,60,13:20,1.2`;

    await stageAndCommitAll(userId, repository, foreflightCsv([row]), "first.csv");
    const [first] = await repository.listFlights(userId);
    expect(first).toBeDefined();

    const [firstRow] = await withUserDb(userId, (tx) =>
      tx
        .select({ sourceRowKey: flights.sourceRowKey })
        .from(flights)
        .where(eq(flights.userId, userId)),
    );
    expect(firstRow.sourceRowKey).toBeTruthy();

    // Same source row again, accepted as a new flight rather than skipped.
    const second = await stageFlightImport(
      userId,
      upload("second.csv", `${foreflightCsv([row])}\n`),
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await getUserImportBatch(userId, second.batchId, 1, 100, repository);
    const staged = detail?.rows.rows ?? [];
    expect(staged).toHaveLength(1);
    expect(staged[0].duplicateCandidate).toBeDefined();

    await decideImportRows(
      userId,
      second.batchId,
      {
        decisions: [
          {
            rowId: staged[0].id,
            action: "accepted" as const,
            duplicateResolution: "accept_new" as const,
          },
        ],
      },
      repository,
    );
    await expect(
      commitImportBatch(userId, second.batchId, repository, repository),
    ).resolves.toBeDefined();

    const committed = await withUserDb(userId, (tx) =>
      tx
        .select({ id: flights.id, sourceRowKey: flights.sourceRowKey })
        .from(flights)
        .where(eq(flights.userId, userId)),
    );
    expect(committed).toHaveLength(2);
    // Exactly one flight owns the source row's identity; the deliberate
    // duplicate leaves it null rather than fighting for it.
    expect(
      committed.filter(({ sourceRowKey }) => sourceRowKey === firstRow.sourceRowKey),
    ).toHaveLength(1);
    expect(
      committed.filter(({ sourceRowKey }) => sourceRowKey === null),
    ).toHaveLength(1);
    expect(await repository.listFlights(userId)).toHaveLength(2);
  });

  it("reports pending attention counts for rows that need a decision", async () => {
    const userId = await createUser("attention-counts");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin] = await seedAirports([`K${suffix}`]);
    const repository = new DrizzleImportRepository();

    const emptyAttention = await repository.getPendingImportAttention(userId);
    expect(emptyAttention.reviewBatches).toBe(0);
    expect(emptyAttention.pendingRows).toBe(0);

    // ZZZZ never resolves, so this row stays unresolved and needs attention.
    await stageFlightImport(
      userId,
      upload(
        "needs-attention.csv",
        foreflightCsv([
          `2026-08-01,SYNTH-A,${origin.code},ZZZZ,,60,12:00,1.0`,
        ]),
      ),
      { imports: repository, flights: repository, airports: repository },
    );

    const attention = await repository.getPendingImportAttention(userId);
    expect(attention.reviewBatches).toBe(1);
    expect(attention.pendingRows).toBeGreaterThan(0);
    expect(attention.href).toBe("/import");
  });

  it("reports every alias namespace a code resolves through, not the winner", async () => {
    // The namespace guard asks "is there ANY airport-namespace alias under
    // which this code names this airport?". Alias priority ranks IATA above
    // FAA-LID, so Boeing Field's `BFI` resolves through its IATA row even
    // though the identical code is also its FAA-LID. A resolver that reported
    // only the winning row said `["iata"]` and the guard rejected a real
    // airport.
    const userId = await createUser("namespace-set");
    const repository = new DrizzleImportRepository();
    const suffix = alphaSuffix();
    const dualCode = `B${suffix}`;
    const [dual] = await seedAirports([dualCode], "iata");
    await getDb()
      .insert(airportAliases)
      .values({
        airportId: dual.id,
        code: dualCode,
        codeType: "faa-lid",
        priority: 30,
      });

    const match = await repository.resolveIdentifier(userId, dualCode);
    expect(match.status).toBe("resolved");
    if (match.status !== "resolved") return;
    expect([...(match.matchedCodeTypes ?? [])].toSorted()).toEqual([
      "faa-lid",
      "iata",
    ]);
    expect(isAirportNamespaceMatch(match)).toBe(true);

    // An IATA-only code is the collision the guard exists for: `OED` is the
    // Medford VOR's identifier as well as an airline code.
    const iataOnly = `O${suffix}`;
    await seedAirports([iataOnly], "iata");
    const navaidish = await repository.resolveIdentifier(userId, iataOnly);
    expect(navaidish.status).toBe("resolved");
    if (navaidish.status !== "resolved") return;
    expect(navaidish.matchedCodeTypes).toEqual(["iata"]);
    expect(isAirportNamespaceMatch(navaidish)).toBe(false);
  });

  it("never resolves an identifier without saying which namespaces named it", async () => {
    // The classifier fails closed on an empty namespace set. Through *this*
    // resolver that case is unreachable, and deliberately so: an airport is
    // only reachable by code through `airport_aliases`, and
    // `airport_aliases_type_valid` restricts `code_type` to the six known
    // namespaces, so a resolved match always carries at least one. This test
    // pins that structural guarantee, so a future release that loosens the
    // constraint — or a resolver that stops reading `code_type` — is caught
    // here rather than by discovering the guard has quietly stopped guarding.
    const userId = await createUser("namespace-nonempty");
    const repository = new DrizzleImportRepository();
    const suffix = alphaSuffix();
    const [seeded] = await seedAirports([`K${suffix}`]);

    await expect(
      getDb().insert(airportAliases).values({
        airportId: seeded.id,
        code: `W${suffix}`,
        codeType: "future-namespace",
        priority: 10,
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "airport_aliases_type_valid" },
    });

    const match = await repository.resolveIdentifier(userId, seeded.code);
    expect(match.status).toBe("resolved");
    if (match.status !== "resolved") return;
    expect(match.matchedCodeTypes.length).toBeGreaterThan(0);
  });

  it("refuses an IATA-only route token and discloses why, but accepts a dual-namespace one", async () => {
    // End to end through the real resolver: the classifier's answer has to
    // survive the database, not just a stub. And the refusal is *disclosed* —
    // silently discarding a token that did resolve to an airport is
    // indistinguishable, from outside, from never having seen it.
    const userId = await createUser("namespace-route");
    const repository = new DrizzleImportRepository();
    const suffix = alphaSuffix();
    const [origin, destination] = await seedAirports([
      `K${suffix}`,
      `P${suffix}`,
    ]);
    const iataOnly = `O${suffix}`;
    await seedAirports([iataOnly], "iata");
    const dualCode = `B${suffix}`;
    const [dual] = await seedAirports([dualCode], "iata");
    await getDb()
      .insert(airportAliases)
      .values({
        airportId: dual.id,
        code: dualCode,
        codeType: "faa-lid",
        priority: 30,
      });

    const staged = await stageFlightImport(
      userId,
      upload(
        "namespace-route.csv",
        foreflightCsv([
          `2026-10-01,SYNTH-A,${origin.code},${destination.code},"${iataOnly} ${dualCode}",120,10:00,1.6`,
        ]),
      ),
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await getUserImportBatch(
      userId,
      staged.batchId,
      1,
      100,
      repository,
    );
    const [row] = detail?.rows.rows ?? [];
    expect(row).toBeDefined();

    const waypoints = (row.proposedFlight.routeNodes ?? []).filter(
      (node) => node.kind === "waypoint",
    );
    expect(waypoints.map((node) => node.identifier)).toEqual([dualCode]);
    expect(
      (row.proposedFlight.routeRejections ?? []).map(
        ({ identifier, reason }) => [identifier, reason],
      ),
    ).toEqual([[iataOnly, "navaid-or-iata-collision"]]);
    expect(
      row.issues.map(({ code, severity }) => [code, severity]),
    ).toContainEqual(["route-token-navaid-collision", "warning"]);
    // A refused route token is never an error: it must not cost the pilot a
    // flight they actually flew.
    expect(row.issues.every(({ severity }) => severity !== "error")).toBe(true);
  });

  it("stamps fingerprint_version with the algorithm that produced the digest", async () => {
    // `fingerprint_version` has exactly one job: say which algorithm produced
    // the value beside it. An accepted duplicate's digest comes from the
    // accepted-duplicate function, not the row fingerprint, so stamping the
    // row-fingerprint version there stated something false in the one column
    // the adoption chain reads to decide whether a digest is superseded.
    const userId = await createUser("fingerprint-version");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [origin, destination] = await seedAirports([
      `K${suffix}`,
      `P${suffix}`,
    ]);
    const repository = new DrizzleImportRepository();
    const row = `2026-11-02,SYNTH-A,${origin.code},${destination.code},,60,15:40,1.1`;

    await stageAndCommitAll(userId, repository, foreflightCsv([row]), "first.csv");
    const [committed] = await withUserDb(userId, (tx) =>
      tx
        .select({
          fingerprintVersion: flights.fingerprintVersion,
          sourceRowKey: flights.sourceRowKey,
        })
        .from(flights)
        .where(eq(flights.userId, userId)),
    );
    expect(committed.fingerprintVersion).toBe(ROW_FINGERPRINT_VERSION);

    const second = await stageFlightImport(
      userId,
      upload("second.csv", `${foreflightCsv([row])}\n`),
      { imports: repository, flights: repository, airports: repository },
    );
    const detail = await getUserImportBatch(userId, second.batchId, 1, 100, repository);
    const staged = detail?.rows.rows ?? [];
    await decideImportRows(
      userId,
      second.batchId,
      {
        decisions: [
          {
            rowId: staged[0].id,
            action: "accepted" as const,
            duplicateResolution: "accept_new" as const,
          },
        ],
      },
      repository,
    );
    await commitImportBatch(userId, second.batchId, repository, repository);

    const rows = await withUserDb(userId, (tx) =>
      tx
        .select({
          fingerprintVersion: flights.fingerprintVersion,
          sourceRowKey: flights.sourceRowKey,
        })
        .from(flights)
        .where(eq(flights.userId, userId)),
    );
    expect(rows).toHaveLength(2);
    const acceptedNew = rows.find(({ sourceRowKey }) => sourceRowKey === null);
    expect(acceptedNew?.fingerprintVersion).toBe(
      ACCEPTED_DUPLICATE_FINGERPRINT_VERSION,
    );
    // The reserved range is what keeps a single integer column honest for
    // both families: it can never be read as a superseded row version, so the
    // adoption chain will not offer this flight as a legacy match.
    expect(acceptedNew?.fingerprintVersion).toBeGreaterThan(
      ROW_FINGERPRINT_VERSION,
    );
    expect(
      isAcceptedDuplicateFingerprintVersion(committed.fingerprintVersion),
    ).toBe(false);
  });

  it("backfills fingerprint_version from the stop count the old algorithm used", async () => {
    // Migration 0018's one deliberate write. The pre-v3 function used version
    // 2 for any flight with more than two committed stops and version 1
    // otherwise, so leaving every historical row on the `1` default would
    // have made the column lie about every multi-stop flight.
    const userId = await createUser("fingerprint-backfill");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const [a, b, c] = await seedAirports([
      `K${suffix}`,
      `R${suffix}`,
      `P${suffix}`,
    ]);
    const twoStopId = randomUUID();
    const threeStopId = randomUUID();
    await withUserDb(userId, async (tx) => {
      for (const [id, stops] of [
        [twoStopId, [a, c]],
        [threeStopId, [a, b, c]],
      ] as const) {
        await tx.insert(flights).values({
          id,
          userId,
          fingerprint: `legacy-${id}`,
          // Deliberately the pre-migration default, as a historical row has.
          fingerprintVersion: 1,
          date: "2020-01-01",
          originAirportId: stops[0].id,
          destinationAirportId: stops.at(-1)!.id,
          kind: "private",
          role: "pilot",
          roleOrigin: "source-default",
          sourceType: "CSV",
        });
        await tx.insert(flightStops).values(
          stops.map((stop, stopOrder) => ({
            userId,
            flightId: id,
            stopOrder,
            airportId: stop.id,
          })),
        );
      }
    });

    // The migration statement, replayed verbatim against these rows.
    await withUserDb(userId, (tx) =>
      tx.execute(sql`
        UPDATE "flights" f
        SET "fingerprint_version" = 2
        WHERE f."fingerprint_version" <> 2
          AND (
            SELECT count(*) FROM "flight_stops" s WHERE s."flight_id" = f."id"
          ) > 2
      `),
    );

    const versions = new Map(
      (
        await withUserDb(userId, (tx) =>
          tx
            .select({
              id: flights.id,
              fingerprintVersion: flights.fingerprintVersion,
            })
            .from(flights)
            .where(eq(flights.userId, userId)),
        )
      ).map(({ id, fingerprintVersion }) => [id, fingerprintVersion]),
    );
    expect(versions.get(twoStopId)).toBe(1);
    expect(versions.get(threeStopId)).toBe(2);
  });
});
