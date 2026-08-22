import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb, withUserDb } from "@/lib/db";
import { DrizzleImportRepository } from "@/lib/db/repositories/drizzle-import-repository";
import {
  airportAliases,
  airports,
  duplicateCandidates,
  flightOverrides,
  flightSources,
  flightStops,
  flights,
  importBatches,
  importRows,
  users,
} from "@/lib/db/schema";
import { reconcileUnresolvedAirportImports } from "./airport-reconciliation";
import {
  automaticallyCommitImport,
  commitImportBatch,
  decideImportRows,
  getUserImportBatch,
} from "./service";
import { stageFlightImport } from "./worker";
import { applyProposalCorrection } from "./corrections";
import { applyDuplicateCandidates } from "./dedupe";
import { createRowFingerprint } from "./fingerprint";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "./review";
import { createManualFlight } from "@/lib/flights/service";
import { applyAirportCatalogRefresh } from "../../../scripts/seed-airports";
import type { AirportReference } from "./airport-resolution";

const enabled =
  process.env.FLIGHT_MAP_RUN_POSTGRES_IMPORT_TESTS === "true" &&
  Boolean(process.env.DATABASE_URL);
const postgresDescribe = enabled ? describe : describe.skip;
const fixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/foreflight-v1.csv", import.meta.url)),
  "utf8",
);
const historicalRepFixture = readFileSync(
  fileURLToPath(
    new URL(
      "./__fixtures__/myflightradar24-historical-rep.csv",
      import.meta.url,
    ),
  ),
  "utf8",
);
const cleanupUsers: string[] = [];
const cleanupAirports: string[] = [];

postgresDescribe("PostgreSQL import journey", () => {
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

  it("persists accepted rows atomically and reads them through the owner flight query", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const originCode = `K${suffix}`;
    const destinationCode = `P${suffix}`;
    const content = fixture
      .replaceAll("KAAA", originCode)
      .replaceAll("KBBB", destinationCode);
    const userId = randomUUID();
    const originId = randomUUID();
    const destinationId = randomUUID();
    const correctionId = randomUUID();
    const correctionCode = `C${suffix}`;
    cleanupUsers.push(userId);
    cleanupAirports.push(originId, destinationId, correctionId);
    await getDb().insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      username: `postgres-${userId.slice(0, 8)}`,
      emailVerified: new Date(),
    });
    await getDb().insert(airports).values([
      {
        id: originId,
        icao: originCode,
        name: `Test ${originCode}`,
        city: "Origin",
        country: "US",
        latitude: 40,
        longitude: -75,
        facility: "general-aviation",
        datasetVersion: "integration-test",
      },
      {
        id: destinationId,
        icao: destinationCode,
        name: `Test ${destinationCode}`,
        city: "Destination",
        country: "US",
        latitude: 41,
        longitude: -74,
        facility: "general-aviation",
        datasetVersion: "integration-test",
      },
      {
        id: correctionId,
        icao: correctionCode,
        name: `Test ${correctionCode}`,
        city: "Correction",
        country: "US",
        latitude: 42,
        longitude: -73,
        facility: "general-aviation",
        datasetVersion: "integration-test",
      },
    ]);
    await getDb().insert(airportAliases).values([
      {
        airportId: originId,
        code: originCode,
        codeType: "icao",
        priority: 10,
      },
      {
        airportId: destinationId,
        code: destinationCode,
        codeType: "icao",
        priority: 10,
      },
      {
        airportId: correctionId,
        code: correctionCode,
        codeType: "icao",
        priority: 10,
      },
    ]);

    const repository = new DrizzleImportRepository();
    const staged = await stageFlightImport(
      userId,
      {
        fileName: "postgres-foreflight.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(content),
        content,
      },
      {
        imports: repository,
        flights: repository,
        airports: repository,
      },
    );
    const detail = await getUserImportBatch(
      userId,
      staged.batchId,
      1,
      100,
      repository,
    );
    const rows = detail?.rows.rows ?? [];
    const selected = await repository.findById(userId, correctionId);
    const corrected = applyProposalCorrection(
      rows[0],
      { origin: selected ?? undefined },
      new Date().toISOString(),
    );
    corrected.commitReady = isImportProposalCommitReady(
      corrected.proposedFlight,
      corrected.issues,
    );
    corrected.validationState = importProposalValidationState(
      corrected.proposedFlight,
      corrected.issues,
    );
    corrected.rowFingerprint = createRowFingerprint(
      userId,
      corrected.proposedFlight,
    );
    rows[0] = corrected;
    await repository.replaceReviewRows(
      userId,
      staged.batchId,
      applyDuplicateCandidates(
        rows,
        await repository.findDuplicateCandidates(userId, rows),
      ),
    );
    const correctedDetail = await getUserImportBatch(
      userId,
      staged.batchId,
      1,
      100,
      repository,
    );
    await decideImportRows(
      userId,
      staged.batchId,
      {
        decisions:
          correctedDetail?.rows.rows.map((row) => ({
            rowId: row.id,
            action: row.commitReady
              ? ("accepted" as const)
              : ("skipped" as const),
            duplicateResolution: row.duplicateCandidate
              ? ("accept_new" as const)
              : undefined,
          })) ?? [],
      },
      repository,
    );
    await expect(
      commitImportBatch(userId, staged.batchId, repository, repository),
    ).resolves.toMatchObject({
      batchId: staged.batchId,
      status: "committed",
    });

    const committed = await getUserImportBatch(
      userId,
      staged.batchId,
      1,
      100,
      repository,
    );
    const ownerFlights = await repository.listFlights(userId);
    expect(ownerFlights).toHaveLength(committed?.counts.committedFlights ?? 0);
    expect(ownerFlights.every((flight) => flight.source === "ForeFlight")).toBe(
      true,
    );
    expect(
      committed?.rows.rows.every((row) => row.rawSnapshot === null),
    ).toBe(true);
    expect(await repository.listFlights(randomUUID())).toEqual([]);
    const persistedRows = await withUserDb(userId, (tx) =>
      tx
        .select({ rawSnapshot: importRows.rawSnapshot })
        .from(importRows)
        .where(
          and(
            eq(importRows.userId, userId),
            eq(importRows.batchId, staged.batchId),
          ),
        ),
    );
    expect(persistedRows.every((row) => row.rawSnapshot === null)).toBe(true);
    const overrides = await withUserDb(userId, (tx) =>
      tx
        .select()
        .from(flightOverrides)
        .where(eq(flightOverrides.userId, userId)),
    );
    expect(overrides).toEqual([
      expect.objectContaining({
        field: "origin",
        actor: `import-row:${rows[0].id}`,
      }),
    ]);

    const duplicateUpload = await stageFlightImport(
      userId,
      {
        fileName: "postgres-duplicate.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.byteLength(
          `${content.replaceAll(originCode, correctionCode)}\n`,
        ),
        content: `${content.replaceAll(originCode, correctionCode)}\n`,
      },
      {
        imports: repository,
        flights: repository,
        airports: repository,
      },
    );
    const duplicateDetail = await getUserImportBatch(
      userId,
      duplicateUpload.batchId,
      1,
      100,
      repository,
    );
    const duplicateRow = duplicateDetail?.rows.rows.find(
      (row) => row.duplicateCandidate,
    );
    expect(duplicateRow?.duplicateCandidate?.score).toBeGreaterThanOrEqual(0.7);
    await decideImportRows(
      userId,
      duplicateUpload.batchId,
      {
        decisions:
          duplicateDetail?.rows.rows.map((row) => ({
            rowId: row.id,
            action: row.id === duplicateRow?.id
              ? ("accepted" as const)
              : ("skipped" as const),
            duplicateResolution:
              row.id === duplicateRow?.id
                ? ("skip_as_duplicate" as const)
                : undefined,
          })) ?? [],
      },
      repository,
    );
    await commitImportBatch(
      userId,
      duplicateUpload.batchId,
      repository,
      repository,
    );
    const persistedCandidate = await withUserDb(userId, (tx) =>
      tx
        .select()
        .from(duplicateCandidates)
        .where(
          and(
            eq(duplicateCandidates.userId, userId),
            eq(duplicateCandidates.batchId, duplicateUpload.batchId),
          ),
        ),
    );
    expect(persistedCandidate).toEqual([
      expect.objectContaining({
        resolution: "skip_as_duplicate",
        candidateScope: "existing-flight",
      }),
    ]);
  });

  it("automatically imports only new rows with idempotency, concurrency safety, and tenant isolation", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase();
    const codes = [`K${suffix}`, `P${suffix}`, `C${suffix}`];
    const airportIds = codes.map(() => randomUUID());
    cleanupAirports.push(...airportIds);
    await getDb().insert(airports).values(
      codes.map((code, index) => ({
        id: airportIds[index],
        icao: code,
        name: `Test ${code}`,
        city: "Test",
        country: "US",
        latitude: 40 + index,
        longitude: -75 + index,
        facility: "general-aviation",
        datasetVersion: "integration-test",
      })),
    );
    await getDb().insert(airportAliases).values(
      codes.map((code, index) => ({
        airportId: airportIds[index],
        code,
        codeType: "icao" as const,
        priority: 10,
      })),
    );
    const ownerId = await createUser("automatic");
    const otherId = await createUser("isolated");
    const repository = new DrizzleImportRepository();
    const initial = foreFlight([
      `2026-01-02,SYNTH-A,${codes[0]},${codes[1]},125.5,08:05,1.2,first`,
      `2026-01-03,SYNTH-A,${codes[1]},${codes[2]},90,14:30,1.0,second`,
    ]);

    const first = await runAutomaticImport(
      ownerId,
      initial,
      "initial.csv",
      repository,
    );
    expect(first).toMatchObject({
      status: "committed",
      reused: false,
      completion: {
        importedRows: 2,
        duplicateRows: 0,
        reviewRequiredRows: 0,
      },
    });

    const repeated = await runAutomaticImport(
      ownerId,
      initial,
      "renamed.csv",
      repository,
    );
    expect(repeated).toMatchObject({
      batchId: first.batchId,
      status: "committed",
      reused: true,
      completion: { importedRows: 2 },
    });

    const overlap = await runAutomaticImport(
      ownerId,
      foreFlight([
        `2026-01-03,SYNTH-A,${codes[1]},${codes[2]},90,14:30,1.0,overlap`,
        `2026-01-04,SYNTH-A,${codes[2]},${codes[0]},110,09:00,1.1,new`,
      ]),
      "overlap.csv",
      repository,
    );
    expect(overlap).toMatchObject({
      status: "committed",
      completion: {
        importedRows: 1,
        duplicateRows: 1,
        skippedRows: 1,
        reviewRequiredRows: 0,
      },
    });

    const other = await runAutomaticImport(
      otherId,
      initial,
      "other-owner.csv",
      repository,
    );
    expect(other.completion?.importedRows).toBe(2);
    expect(await repository.listFlights(ownerId)).toHaveLength(3);
    expect(await repository.listFlights(otherId)).toHaveLength(2);
    expect(
      await getUserImportBatch(otherId, first.batchId, 1, 10, repository),
    ).toBeNull();
    await expect(
      withUserDb(otherId, (tx) =>
        tx.select().from(flights).where(eq(flights.userId, ownerId)),
      ),
    ).resolves.toEqual([]);

    const concurrentRows = [
      foreFlight([
        `2026-01-05,SYNTH-A,${codes[0]},${codes[2]},130,10:00,1.3,left`,
      ]),
      foreFlight([
        `2026-01-05,SYNTH-A,${codes[0]},${codes[2]},130,10:00,1.3,right`,
      ]),
    ];
    const staged = await Promise.all(
      concurrentRows.map((content, index) =>
        stageFlightImport(
          ownerId,
          upload(content, `concurrent-${index}.csv`),
          {
            imports: repository,
            flights: repository,
            airports: repository,
          },
        ),
      ),
    );
    const completed = await Promise.all(
      staged.map((result) =>
        automaticallyCommitImport(ownerId, result, repository, repository),
      ),
    );
    expect(await repository.listFlights(ownerId)).toHaveLength(4);
    expect(
      completed.reduce(
        (sum, result) => sum + (result.completion?.importedRows ?? 0),
        0,
      ),
    ).toBe(1);
  });

  it("refreshes, resolves, and idempotently imports historical REP flights without remapping them to SAI", async () => {
    const references: AirportReference[] = [
      {
        ident: "VTBD",
        type: "large_airport",
        name: "Don Mueang International Airport",
        latitude: 13.9126,
        longitude: 100.607,
        isoCountry: "TH",
        municipality: "Bangkok",
        scheduledService: true,
        gpsCode: "VTBD",
        iataCode: "DMK",
      },
      {
        ident: "KH-0003",
        type: "closed",
        name: "Siem Reap International Airport",
        latitude: 13.410676,
        longitude: 103.812074,
        isoCountry: "KH",
        municipality: "Siem Reap",
        scheduledService: false,
        keywords: "REP, VDSR",
      },
      {
        ident: "VDSA",
        type: "large_airport",
        name: "Siem Reap-Angkor International Airport",
        latitude: 13.36974,
        longitude: 104.223831,
        isoCountry: "KH",
        municipality: "Siem Reap",
        scheduledService: true,
        gpsCode: "VDSA",
        iataCode: "SAI",
      },
      {
        ident: "WSSS",
        type: "large_airport",
        name: "Singapore Changi Airport",
        latitude: 1.35019,
        longitude: 103.994003,
        isoCountry: "SG",
        municipality: "Singapore",
        scheduledService: true,
        gpsCode: "WSSS",
        iataCode: "SIN",
      },
    ];
    const firstRefresh = await applyAirportCatalogRefresh(
      getDb(),
      references,
      "historical-rep-postgres-test",
    );
    cleanupAirports.push(...firstRefresh.ids);
    const firstIdentitySnapshot = await getDb()
      .select({
        airportId: airports.id,
        sourceIdent: airports.sourceIdent,
        iata: airports.iata,
        alias: airportAliases.code,
        aliasType: airportAliases.codeType,
        aliasPriority: airportAliases.priority,
      })
      .from(airports)
      .innerJoin(airportAliases, eq(airportAliases.airportId, airports.id))
      .where(inArray(airports.id, firstRefresh.ids))
      .orderBy(airports.id, airportAliases.priority, airportAliases.code);
    const repeatedRefresh = await applyAirportCatalogRefresh(
      getDb(),
      references,
      "historical-rep-postgres-test",
    );
    const repeatedIdentitySnapshot = await getDb()
      .select({
        airportId: airports.id,
        sourceIdent: airports.sourceIdent,
        iata: airports.iata,
        alias: airportAliases.code,
        aliasType: airportAliases.codeType,
        aliasPriority: airportAliases.priority,
      })
      .from(airports)
      .innerJoin(airportAliases, eq(airportAliases.airportId, airports.id))
      .where(inArray(airports.id, repeatedRefresh.ids))
      .orderBy(airports.id, airportAliases.priority, airportAliases.code);

    expect(repeatedRefresh.ids).toEqual(firstRefresh.ids);
    expect(repeatedIdentitySnapshot).toEqual(firstIdentitySnapshot);
    expect(repeatedRefresh).toMatchObject({
      created: 0,
      summary: {
        matchedBySourceIdent: 4,
        collisions: 0,
        ambiguities: 0,
      },
    });
    const refreshedAirports = await getDb()
      .select({
        sourceIdent: airports.sourceIdent,
        iata: airports.iata,
      })
      .from(airports)
      .where(inArray(airports.id, firstRefresh.ids));
    expect(refreshedAirports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdent: "KH-0003",
          iata: "REP",
        }),
        expect.objectContaining({
          sourceIdent: "VDSA",
          iata: "SAI",
        }),
      ]),
    );
    expect(
      repeatedIdentitySnapshot
        .filter(({ sourceIdent }) => sourceIdent === "KH-0003")
        .map(({ alias }) => alias),
    ).toEqual(["VDSR", "REP", "KH-0003"]);

    const userId = await createUser("historical-rep");
    const repository = new DrizzleImportRepository();
    const rep = await repository.resolveIdentifier(userId, "REP");
    const vdsr = await repository.resolveIdentifier(userId, "VDSR");
    const sai = await repository.resolveIdentifier(userId, "SAI");
    expect(rep).toMatchObject({
      status: "resolved",
      airport: {
        code: "REP",
        name: "Siem Reap International Airport",
        lat: 13.410676,
        lon: 103.812074,
      },
    });
    expect(vdsr).toMatchObject({
      status: "resolved",
    });
    expect(sai).toMatchObject({
      status: "resolved",
      airport: {
        code: "SAI",
        name: "Siem Reap-Angkor International Airport",
        lat: 13.36974,
        lon: 104.223831,
      },
    });
    if (
      rep.status !== "resolved" ||
      vdsr.status !== "resolved" ||
      sai.status !== "resolved"
    ) {
      throw new Error("Expected REP, VDSR, and SAI to resolve.");
    }
    expect(vdsr.airportId).toBe(rep.airportId);
    expect(sai.airportId).not.toBe(rep.airportId);

    const first = await runAutomaticImport(
      userId,
      historicalRepFixture,
      "historical-rep.csv",
      repository,
    );
    expect(first).toMatchObject({
      status: "committed",
      reused: false,
      completion: {
        importedRows: 2,
        duplicateRows: 0,
        reviewRequiredRows: 0,
      },
    });
    const detail = await getUserImportBatch(
      userId,
      first.batchId,
      1,
      10,
      repository,
    );
    expect(detail?.rows.rows).toHaveLength(2);
    expect(
      detail?.rows.rows.every(
        ({ issues, validationState, commitReady }) =>
          issues.length === 0 &&
          validationState === "ready" &&
          commitReady,
      ),
    ).toBe(true);

    const repeated = await runAutomaticImport(
      userId,
      historicalRepFixture,
      "renamed-historical-rep.csv",
      repository,
    );
    expect(repeated).toMatchObject({
      batchId: first.batchId,
      status: "committed",
      reused: true,
      completion: { importedRows: 2 },
    });
    expect(await repository.listFlights(userId)).toMatchObject([
      {
        origin: { code: "REP" },
        destination: { code: "SIN" },
      },
      {
        origin: { code: "DMK" },
        destination: { code: "REP" },
      },
    ]);
  });

  it("persists one parent with ordered repeated stops and tenant-scoped legs", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    cleanupUsers.push(userId, otherUserId);
    await getDb().insert(users).values([
      {
        id: userId,
        email: `${userId}@example.test`,
        username: `route-${userId.slice(0, 8)}`,
        emailVerified: new Date(),
      },
      {
        id: otherUserId,
        email: `${otherUserId}@example.test`,
        username: `route-${otherUserId.slice(0, 8)}`,
        emailVerified: new Date(),
      },
    ]);
    const routeAirportIds = Array.from({ length: 4 }, () => randomUUID());
    cleanupAirports.push(...routeAirportIds);
    await getDb().insert(airports).values(
      routeAirportIds.map((id, index) => ({
        id,
        icao: `TST${index}`,
        name: `Route Test ${index}`,
        city: `Stop ${index}`,
        country: "US",
        latitude: 40 + index,
        longitude: -75 + index,
        facility: "general-aviation",
        datasetVersion: "integration-test",
      })),
    );
    const repository = new DrizzleImportRepository();
    const created = await createManualFlight(
      userId,
      {
        classification: "personal",
        date: "2026-08-14",
        originAirportId: routeAirportIds[0],
        intermediateAirportIds: [
          routeAirportIds[1],
          routeAirportIds[2],
          routeAirportIds[3],
        ],
        destinationAirportId: routeAirportIds[0],
        durationHours: 3.5,
      },
      repository,
    );

    expect(created.airportSequence?.map(({ code }) => code)).toEqual([
      "TST0",
      "TST1",
      "TST2",
      "TST3",
      "TST0",
    ]);
    expect(created.durationHours).toBe(3.5);
    expect(await repository.listFlights(otherUserId)).toEqual([]);
    const ownerStops = await withUserDb(userId, (tx) =>
      tx
        .select()
        .from(flightStops)
        .where(eq(flightStops.flightId, created.id))
        .orderBy(flightStops.stopOrder),
    );
    const otherStops = await withUserDb(otherUserId, (tx) =>
      tx
        .select()
        .from(flightStops)
        .where(eq(flightStops.flightId, created.id)),
    );
    expect(ownerStops.map(({ airportId }) => airportId)).toEqual([
      routeAirportIds[0],
      routeAirportIds[1],
      routeAirportIds[2],
      routeAirportIds[3],
      routeAirportIds[0],
    ]);
    expect(otherStops).toEqual([]);
  });

  it("reconciles pending unresolved rows after alias refresh without cross-tenant or duplicate writes", async () => {
    const ownerId = await createUser("reconcile-owner");
    const otherId = await createUser("reconcile-other");
    const airportIds = Array.from({ length: 5 }, () => randomUUID());
    cleanupAirports.push(...airportIds);
    const [kaaaId, kbbbId, w01Id, omkId, unknownId] = airportIds;
    await getDb().insert(airports).values([
      airportRow(kaaaId, "KAAA", "KAAA"),
      airportRow(kbbbId, "KBBB", "KBBB"),
      airportRow(w01Id, "KW01", "W01"),
      airportRow(omkId, "KOMK", "OMK"),
      airportRow(unknownId, null, "ZX9"),
    ]);
    await getDb().insert(airportAliases).values([
      { airportId: kaaaId, code: "KAAA", codeType: "icao", priority: 10 },
      { airportId: kbbbId, code: "KBBB", codeType: "icao", priority: 10 },
    ]);
    const repository = new DrizzleImportRepository();
    const owner = await runAutomaticImport(
      ownerId,
      foreFlight([
        "2026-08-01,SYNTH-A,KAAA,KBBB,50,09:00,0.5,clean",
        "2026-08-02,SYNTH-A,w01,OMK,60,10:00,0.6,regional",
        "2026-08-03,SYNTH-A,UNKNOWN,OMK,70,11:00,0.7,unknown",
      ]),
      "owner-reconcile.csv",
      repository,
    );
    const other = await runAutomaticImport(
      otherId,
      foreFlight([
        "2026-08-04,SYNTH-A,W01,OMK,80,12:00,0.8,other",
      ]),
      "other-reconcile.csv",
      repository,
    );
    expect(await repository.listFlights(ownerId)).toHaveLength(1);
    await getDb().insert(airportAliases).values([
      { airportId: w01Id, code: "W01", codeType: "faa-lid", priority: 30 },
      { airportId: w01Id, code: "KW01", codeType: "icao", priority: 10 },
      { airportId: omkId, code: "OMK", codeType: "iata", priority: 20 },
      { airportId: omkId, code: "KOMK", codeType: "icao", priority: 10 },
    ]);

    const partial = await reconcileUnresolvedAirportImports(
      [{ userId: ownerId, batchId: owner.batchId }],
      { imports: repository, flights: repository, airports: repository },
    );
    expect(partial).toMatchObject({
      scanned: 4,
      resolved: 3,
      unknown: 1,
      completed: 0,
    });
    expect(await repository.listFlights(ownerId)).toHaveLength(2);
    expect(await repository.listFlights(otherId)).toHaveLength(0);
    expect((await repository.getBatch(otherId, other.batchId))?.status).toBe(
      "review",
    );

    await getDb().insert(airportAliases).values({
      airportId: unknownId,
      code: "UNKNOWN",
      codeType: "local",
      priority: 30,
    });
    const completed = await reconcileUnresolvedAirportImports(
      [{ userId: ownerId, batchId: owner.batchId }],
      { imports: repository, flights: repository, airports: repository },
    );
    expect(completed).toMatchObject({
      scanned: 1,
      resolved: 1,
      completed: 1,
    });
    expect(await repository.listFlights(ownerId)).toHaveLength(3);
    expect(
      await reconcileUnresolvedAirportImports(
        [{ userId: ownerId, batchId: owner.batchId }],
        { imports: repository, flights: repository, airports: repository },
      ),
    ).toMatchObject({ scanned: 0, completed: 0 });
    expect(await repository.listFlights(ownerId)).toHaveLength(3);
  });
});

function foreFlight(rows: string[]): string {
  return [
    "ForeFlight Logbook Import",
    "",
    "Aircraft Table",
    "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)",
    "SYNTH-A,C172,2020,Example,Trainer,Fixed,Reciprocating,airplane,Airplane Single Engine Land",
    "Flights Table",
    "Date,AircraftID,From,To,Distance,TimeOut,TotalTime,PilotComments",
    ...rows,
    "",
  ].join("\n");
}

function upload(content: string, fileName: string) {
  return {
    fileName,
    mimeType: "text/csv",
    sizeBytes: Buffer.byteLength(content),
    content,
  };
}

function airportRow(
  id: string,
  icao: string | null,
  localCode: string | null,
) {
  return {
    id,
    sourceIdent: `TEST-${id}`,
    sourceIdentProvenance: `ourairports-sha256:${"a".repeat(64)}`,
    icao,
    localCode,
    name: `Test ${localCode ?? icao}`,
    city: "Test",
    country: "US",
    latitude: 48,
    longitude: -119,
    facility: "general-aviation",
    datasetVersion: "reconciliation-test",
  };
}

async function runAutomaticImport(
  userId: string,
  content: string,
  fileName: string,
  repository: DrizzleImportRepository,
) {
  const staged = await stageFlightImport(
    userId,
    upload(content, fileName),
    {
      imports: repository,
      flights: repository,
      airports: repository,
    },
  );
  return automaticallyCommitImport(
    userId,
    staged,
    repository,
    repository,
  );
}

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  cleanupUsers.push(userId);
  await getDb().insert(users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
    username: `${label}-${userId.slice(0, 8)}`,
    emailVerified: new Date(),
  });
  return userId;
}
