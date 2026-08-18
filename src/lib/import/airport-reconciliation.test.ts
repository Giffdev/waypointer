import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { applyProposalCorrection } from "./corrections";
import { createRowFingerprint } from "./fingerprint";
import {
  reconcileUnresolvedAirportImports,
} from "./airport-reconciliation";
import {
  InMemoryImportRepository,
  type InMemoryAirportSeed,
} from "./in-memory-repository";
import {
  importProposalValidationState,
  isImportProposalCommitReady,
} from "./review";
import { automaticallyCommitImport } from "./service";
import { stageFlightImport } from "./worker";

const airport = (code: string, name = `Synthetic ${code}`): Airport => ({
  code,
  name,
  city: "Test",
  country: "US",
  lat: 48,
  lon: -119,
  facility: "general-aviation",
});

const baseCatalog: InMemoryAirportSeed[] = [
  { id: "airport-kaaa", airport: airport("KAAA"), aliases: ["KAAA"] },
  { id: "airport-kbbb", airport: airport("KBBB"), aliases: ["KBBB"] },
];

const expandedCatalog: InMemoryAirportSeed[] = [
  ...baseCatalog,
  {
    id: "airport-w01",
    airport: airport("W01", "Tonasket Municipal Airport"),
    aliases: ["W01", "KW01"],
  },
  {
    id: "airport-omk",
    airport: airport("OMK", "Omak Airport"),
    aliases: ["OMK", "KOMK"],
  },
  {
    id: "airport-s18",
    airport: airport("S18", "Forks Airport"),
    aliases: ["S18"],
  },
  {
    id: "airport-uil",
    airport: airport("UIL", "Quillayute Airport"),
    aliases: ["UIL", "KUIL"],
  },
];

describe("unresolved airport reconciliation", () => {
  it("resolves regional aliases, completes once, preserves raw input, and isolates tenants", async () => {
    const store = new InMemoryImportRepository(baseCatalog);
    const owner = await stageAndAuto(
      store,
      "user-a",
      foreFlight([
        "2026-08-01,SYNTH-A,w01,kOmK,90,10:00,1.0,regional",
        "2026-08-02,SYNTH-A,S18,KUIL,80,11:00,0.9,regional",
      ]),
      "owner.csv",
    );
    const other = await stageAndAuto(
      store,
      "user-b",
      foreFlight([
        "2026-08-03,SYNTH-A,W01,OMK,70,12:00,0.8,other",
      ]),
      "other.csv",
    );
    expect(owner.status).toBe("review");
    expect(other.status).toBe("review");
    expect(
      (await store.getRowsForCommit("user-a", owner.batchId))?.[0].rawSnapshot,
    ).toContain("w01");

    store.replaceAirportCatalog(expandedCatalog);
    const first = await reconcileUnresolvedAirportImports(
      [{ userId: "user-a", batchId: owner.batchId }],
      { imports: store, flights: store, airports: store },
    );
    expect(first).toEqual({
      scanned: 4,
      resolved: 4,
      ambiguous: 0,
      unknown: 0,
      completed: 1,
      conflicts: 0,
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
    expect(await store.listFlights("user-b")).toHaveLength(0);
    const rows = await store.getRowsForCommit("user-a", owner.batchId);
    expect(rows?.[0].proposedFlight.originIdentifier).toBe("W01");
    expect(rows?.[0].proposedFlight.destinationIdentifier).toBe("KOMK");
    expect(rows?.[0].rawSnapshot).toBeNull();

    const rerun = await reconcileUnresolvedAirportImports(
      [
        { userId: "user-a", batchId: owner.batchId },
        { userId: "user-a", batchId: owner.batchId },
      ],
      { imports: store, flights: store, airports: store },
    );
    expect(rerun).toEqual({
      scanned: 0,
      resolved: 0,
      ambiguous: 0,
      unknown: 0,
      completed: 0,
      conflicts: 0,
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
    expect((await store.getBatch("user-b", other.batchId))?.status).toBe(
      "review",
    );
  });

  it("commits newly resolvable rows in a mixed batch without duplicating prior flights", async () => {
    const store = new InMemoryImportRepository(baseCatalog);
    const staged = await stageAndAuto(
      store,
      "user-a",
      foreFlight([
        "2026-08-01,SYNTH-A,KAAA,KBBB,50,09:00,0.5,already clean",
        "2026-08-02,SYNTH-A,W01,OMK,60,10:00,0.6,new aliases",
        "2026-08-03,SYNTH-A,UNKNOWN,OMK,70,11:00,0.7,unknown",
        "2026-08-04,SYNTH-A,DUP,OMK,80,12:00,0.8,collision",
      ]),
      "mixed.csv",
    );
    expect(staged.status).toBe("review");
    expect(await store.listFlights("user-a")).toHaveLength(1);
    store.replaceAirportCatalog([
      ...expandedCatalog,
      { id: "airport-dup-a", airport: airport("DA"), aliases: ["DUP"] },
      { id: "airport-dup-b", airport: airport("DB"), aliases: ["DUP"] },
    ]);

    const counts = await reconcileUnresolvedAirportImports(
      [{ userId: "user-a", batchId: staged.batchId }],
      { imports: store, flights: store, airports: store },
    );
    expect(counts).toEqual({
      scanned: 6,
      resolved: 4,
      ambiguous: 1,
      unknown: 1,
      completed: 0,
      conflicts: 0,
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
    const detail = await store.getRowsForCommit("user-a", staged.batchId);
    expect(
      detail?.find(
        (row) => row.proposedFlight.originIdentifier === "UNKNOWN",
      )?.validationState,
    ).toBe("unresolved");
    expect(
      detail?.find((row) => row.proposedFlight.originIdentifier === "DUP")
        ?.validationState,
    ).toBe("ambiguous");

    const rerun = await reconcileUnresolvedAirportImports(
      [{ userId: "user-a", batchId: staged.batchId }],
      { imports: store, flights: store, airports: store },
    );
    expect(rerun).toMatchObject({
      scanned: 1,
      resolved: 0,
      ambiguous: 0,
      unknown: 1,
      completed: 0,
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
  });

  it("never replaces an explicit user airport correction", async () => {
    const store = new InMemoryImportRepository(baseCatalog);
    const staged = await stageAndAuto(
      store,
      "user-a",
      foreFlight([
        "2026-08-01,SYNTH-A,W01,KBBB,50,09:00,0.5,corrected",
      ]),
      "corrected.csv",
    );
    const rows = (await store.getRowsForCommit("user-a", staged.batchId)) ?? [];
    const selected = await store.findById("user-a", "airport-kaaa");
    const corrected = applyProposalCorrection(
      rows[0],
      { origin: selected ?? undefined },
      "2026-08-14T20:00:00.000Z",
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
      "user-a",
      corrected.proposedFlight,
    );
    rows[0] = corrected;
    const batch = await store.getBatch("user-a", staged.batchId);
    await store.replaceReviewRows(
      "user-a",
      staged.batchId,
      rows,
      batch?.updatedAt,
    );
    store.replaceAirportCatalog(expandedCatalog);

    const counts = await reconcileUnresolvedAirportImports(
      [{ userId: "user-a", batchId: staged.batchId }],
      { imports: store, flights: store, airports: store },
    );
    expect(counts.scanned).toBe(0);
    const preserved = await store.getRowsForCommit("user-a", staged.batchId);
    expect(preserved?.[0].proposedFlight.origin).toMatchObject({
      status: "resolved",
      airportId: "airport-kaaa",
    });
    expect(preserved?.[0].corrections?.[0].field).toBe("origin");
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

async function stageAndAuto(
  store: InMemoryImportRepository,
  userId: string,
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
    { imports: store, flights: store, airports: store },
  );
  return automaticallyCommitImport(userId, staged, store, store);
}
