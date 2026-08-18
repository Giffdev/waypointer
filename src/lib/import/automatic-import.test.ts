import { describe, expect, it } from "vitest";
import type { Airport } from "../flight-data";
import { InMemoryImportRepository } from "./in-memory-repository";
import { automaticallyCommitImport, getUserImportBatch } from "./service";
import { stageFlightImport } from "./worker";

const airport = (code: string): Airport => ({
  code,
  name: `Synthetic ${code}`,
  city: "Test",
  country: "US",
  lat: 40,
  lon: -75,
  facility: "general-aviation",
});

function repository() {
  return new InMemoryImportRepository([
    { id: "airport-kaaa", airport: airport("KAAA"), aliases: ["KAAA"] },
    { id: "airport-kbbb", airport: airport("KBBB"), aliases: ["KBBB"] },
    { id: "airport-kccc", airport: airport("KCCC"), aliases: ["KCCC"] },
  ]);
}

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

function upload(content: string, fileName = "logbook.csv") {
  return {
    fileName,
    mimeType: "text/csv",
    sizeBytes: Buffer.byteLength(content),
    content,
  };
}

async function importAutomatically(
  store: InMemoryImportRepository,
  content: string,
  fileName?: string,
) {
  const repositories = { imports: store, flights: store, airports: store };
  const staged = await stageFlightImport(
    "user-a",
    upload(content, fileName),
    repositories,
  );
  return automaticallyCommitImport(
    "user-a",
    staged,
    store,
    store,
  );
}

describe("automatic synchronous import completion", () => {
  it("commits clean rows immediately and makes an identical re-import idempotent", async () => {
    const store = repository();
    const content = foreFlight([
      "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,first",
      "2026-01-03,SYNTH-A,KBBB,KCCC,90,14:30,1.0,second",
    ]);

    const first = await importAutomatically(store, content);
    expect(first).toMatchObject({
      status: "committed",
      reused: false,
      completion: {
        totalRows: 2,
        importedRows: 2,
        duplicateRows: 0,
        invalidRows: 0,
        reviewRequiredRows: 0,
      },
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);

    const repeated = await importAutomatically(store, content, "renamed.csv");
    expect(repeated).toMatchObject({
      batchId: first.batchId,
      status: "committed",
      reused: true,
      completion: { importedRows: 2, duplicateRows: 0 },
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
  });

  it("imports only new rows from overlapping exports", async () => {
    const store = repository();
    await importAutomatically(
      store,
      foreFlight([
        "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,first",
        "2026-01-03,SYNTH-A,KBBB,KCCC,90,14:30,1.0,overlap",
      ]),
      "first.csv",
    );

    const overlap = await importAutomatically(
      store,
      foreFlight([
        "2026-01-03,SYNTH-A,KBBB,KCCC,90,14:30,1.0,overlap again",
        "2026-01-04,SYNTH-A,KCCC,KAAA,110,09:00,1.1,new",
      ]),
      "overlap.csv",
    );

    expect(overlap).toMatchObject({
      status: "committed",
      completion: {
        totalRows: 2,
        importedRows: 1,
        duplicateRows: 1,
        skippedRows: 1,
        invalidRows: 0,
        reviewRequiredRows: 0,
      },
    });
    expect(await store.listFlights("user-a")).toHaveLength(3);
  });

  it("treats a duplicate-only export as fully resolved", async () => {
    const store = repository();
    await importAutomatically(
      store,
      foreFlight([
        "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,first export",
      ]),
      "first.csv",
    );

    const duplicateOnly = await importAutomatically(
      store,
      foreFlight([
        "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,later export",
      ]),
      "duplicate-only.csv",
    );

    expect(duplicateOnly).toMatchObject({
      status: "committed",
      completion: {
        totalRows: 1,
        importedRows: 0,
        duplicateRows: 1,
        skippedRows: 1,
        invalidRows: 0,
        reviewRequiredRows: 0,
      },
    });
    expect(await store.listFlights("user-a")).toHaveLength(1);
  });

  it("commits valid rows while retaining only invalid rows for correction", async () => {
    const store = repository();
    await importAutomatically(
      store,
      foreFlight([
        "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,seed",
      ]),
      "seed.csv",
    );

    const mixed = await importAutomatically(
      store,
      foreFlight([
        "2026-01-02,SYNTH-A,KAAA,KBBB,125.5,08:05,1.2,duplicate",
        "2026-01-05,SYNTH-A,KBBB,KCCC,90,12:00,1.0,new",
        "2026-01-06,SYNTH-A,KAAA,KZZZ,90,13:00,1.0,invalid",
      ]),
      "mixed.csv",
    );

    expect(mixed).toMatchObject({
      status: "review",
      completion: {
        totalRows: 3,
        importedRows: 1,
        duplicateRows: 1,
        skippedRows: 1,
        invalidRows: 1,
        reviewRequiredRows: 1,
      },
    });
    expect(await store.listFlights("user-a")).toHaveLength(2);
    const detail = await getUserImportBatch(
      "user-a",
      mixed.batchId,
      1,
      10,
      store,
    );
    expect(detail?.rows.rows.filter((row) => row.decision === "pending"))
      .toEqual([expect.objectContaining({ commitReady: false })]);
  });

  it("keeps a total validation failure in exception review without redirectable success", async () => {
    const store = repository();
    const failed = await importAutomatically(
      store,
      foreFlight([
        "2026-01-06,SYNTH-A,KXXX,KZZZ,90,13:00,1.0,invalid",
      ]),
      "invalid.csv",
    );

    expect(failed).toMatchObject({
      status: "review",
      completion: {
        totalRows: 1,
        importedRows: 0,
        duplicateRows: 0,
        invalidRows: 1,
        reviewRequiredRows: 1,
      },
    });
    expect(await store.listFlights("user-a")).toHaveLength(0);
  });

  it("uses canonical uniqueness to prevent concurrent overlapping inserts", async () => {
    const store = repository();
    const left = foreFlight([
      "2026-01-07,SYNTH-A,KAAA,KBBB,100,10:00,1.0,left export",
    ]);
    const right = foreFlight([
      "2026-01-07,SYNTH-A,KAAA,KBBB,100,10:00,1.0,right export",
    ]);
    const repositories = { imports: store, flights: store, airports: store };
    const staged = await Promise.all([
      stageFlightImport("user-a", upload(left, "left.csv"), repositories),
      stageFlightImport("user-a", upload(right, "right.csv"), repositories),
    ]);
    const completed = await Promise.all(
      staged.map((result) =>
        automaticallyCommitImport("user-a", result, store, store),
      ),
    );

    expect(await store.listFlights("user-a")).toHaveLength(1);
    expect(
      completed.reduce(
        (sum, result) => sum + (result.completion?.importedRows ?? 0),
        0,
      ),
    ).toBe(1);
  });
});
